import { resolve, sep } from "node:path";
import type {
  StudyAnalysisCommand,
  StudyCommand,
  StudyConfig,
  StudyListEntry,
  StudyServerEvent,
  StudySnapshot,
} from "../contracts";

export interface StudyApplication {
  list(): Promise<StudyListEntry[]>;
  create(input: unknown): Promise<StudySnapshot>;
  get(id: string): Promise<StudySnapshot>;
  command(id: string, input: StudyCommand): Promise<StudySnapshot>;
  analyze(id: string, input: StudyAnalysisCommand): Promise<StudySnapshot>;
  import(input: unknown): Promise<StudySnapshot>;
  export(id: string): Promise<unknown>;
  watch(input: unknown): Promise<StudySnapshot>;
  subscribe(listener: (event: StudyServerEvent) => void): () => void;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function readBoundedJson(
  source: Request | Response,
  limit = 16 * 1024 * 1024,
): Promise<unknown> {
  if (Number(source.headers.get("content-length")) > limit)
    throw new HttpError(413, "読み込むデータが大きすぎます");
  const reader = source.body?.getReader();
  if (!reader) throw new HttpError(400, "JSONデータが必要です");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new HttpError(413, "読み込むデータが大きすぎます");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new HttpError(400, "JSONファイルの形式を確認してください");
  }
}

function json(value: unknown, status = 200) {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

export function createStudyHttpHandler(
  app: StudyApplication,
  config: StudyConfig,
  assetsDirectory: string,
) {
  return async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== "127.0.0.1")
        throw new HttpError(403, "127.0.0.1のローカル画面から利用してください");
      const origin = request.headers.get("origin");
      if (origin !== null && origin !== url.origin)
        throw new HttpError(403, "別のサイトからの操作は受け付けません");
      if (!["GET", "HEAD"].includes(request.method) && origin !== url.origin)
        throw new HttpError(403, "ローカル画面から操作してください");
      if (request.method === "GET" && url.pathname === "/api/config") return json(config);
      if (request.method === "GET" && url.pathname === "/api/studies")
        return json(await app.list());
      if (request.method === "POST" && url.pathname === "/api/studies")
        return json(await app.create(await readBoundedJson(request)), 201);
      if (request.method === "POST" && url.pathname === "/api/import")
        return json(await app.import(await readBoundedJson(request)), 201);
      if (request.method === "POST" && url.pathname === "/api/live")
        return json(await app.watch(await readBoundedJson(request)), 201);
      if (request.method === "GET" && url.pathname === "/api/events") {
        const studyId = url.searchParams.get("studyId");
        if (!studyId) throw new HttpError(400, "検討を選択してください");
        const snapshot = await app.get(studyId);
        let cleanup = () => {};
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new TextEncoder();
            let closed = false;
            const send = (event: StudyServerEvent) => {
              if (!closed) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
            };
            send({ type: "snapshot", snapshot });
            const unsubscribe = app.subscribe((event) => {
              const id = event.type === "snapshot" ? event.snapshot.study.id : event.studyId;
              if (id === studyId || id === null) send(event);
            });
            const heartbeat = setInterval(() => {
              if (!closed) controller.enqueue(encoder.encode(": heartbeat\n\n"));
            }, 15000);
            const onAbort = () => {
              if (closed) return;
              cleanup();
              controller.close();
            };
            cleanup = () => {
              if (closed) return;
              closed = true;
              unsubscribe();
              clearInterval(heartbeat);
              request.signal.removeEventListener("abort", onAbort);
            };
            request.signal.addEventListener("abort", onAbort, { once: true });
            if (request.signal.aborted) onAbort();
          },
          cancel() {
            cleanup();
          },
        });
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-store",
            "X-Accel-Buffering": "no",
          },
        });
      }
      const match = /^\/api\/studies\/([a-zA-Z0-9-]+)(?:\/(commands|analysis|export))?$/.exec(
        url.pathname,
      );
      if (match) {
        const [, id, operation] = match;
        if (request.method === "GET" && !operation) return json(await app.get(id));
        if (request.method === "GET" && operation === "export")
          return new Response(JSON.stringify(await app.export(id), null, 2), {
            headers: {
              "Content-Type": "application/json",
              "Content-Disposition": `attachment; filename="four-shogi-${id}.json"`,
              "Cache-Control": "no-store",
            },
          });
        if (request.method === "POST" && operation === "commands")
          return json(await app.command(id, (await readBoundedJson(request)) as StudyCommand));
        if (request.method === "POST" && operation === "analysis")
          return json(
            await app.analyze(id, (await readBoundedJson(request)) as StudyAnalysisCommand),
          );
      }
      if (url.pathname.startsWith("/api/")) throw new HttpError(404, "操作先が見つかりません");
      if (!["GET", "HEAD"].includes(request.method)) throw new HttpError(405, "未対応の操作です");
      const root = resolve(assetsDirectory);
      const path = resolve(
        root,
        `.${decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)}`,
      );
      if (!path.startsWith(root + sep)) throw new HttpError(404, "ファイルが見つかりません");
      const file = Bun.file(path);
      if (!(await file.exists()))
        throw new HttpError(404, "画面をビルドしてから起動してください（bun run study）");
      return new Response(request.method === "HEAD" ? null : file, {
        headers: {
          "Content-Type": file.type,
          "Cache-Control": "no-cache",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch (error) {
      return json(
        { error: error instanceof Error ? error.message : "処理できませんでした" },
        error instanceof HttpError ? error.status : 400,
      );
    }
  };
}
