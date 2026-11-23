import { roomCodeSchema, roomSocketContract } from "@tetraboard/protocol";
import { roomShareMetadata, type ShareRoom } from "@tetraboard/protocol/room-sharing";

import { dynamicAssetHeaders, escapeShareHtml, fetchUnconditionalAsset } from "./htmlAssets";

export { escapeShareHtml } from "./htmlAssets";

async function readShareRoom(url: URL, env: Env): Promise<ShareRoom | null> {
  const id = url.pathname.split("/")[2];
  const instances = url.searchParams.getAll("invite");
  const query = roomSocketContract.query.safeParse({ instanceId: instances[0] });
  if (
    !roomCodeSchema.safeParse(id).success ||
    instances.length !== 1 ||
    !query.success ||
    !query.data.instanceId
  )
    return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(id!));
    return await Promise.race([
      stub.getShareMetadata(query.data.instanceId),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), 1500);
      }),
    ]);
  } catch {
    // 共有情報の失敗でもルーム画面の配信を継続します。
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function serveRoomShareHtml(
  request: Request,
  env: Env,
  assets: Fetcher,
): Promise<Response> {
  const url = new URL(request.url);
  const room = await readShareRoom(url, env);
  const metadata = roomShareMetadata(url.origin, room);
  return serveShareHtml(request, assets, metadata);
}

export async function serveShareHtml(
  request: Request,
  assets: Fetcher,
  metadata: ReturnType<typeof roomShareMetadata>,
): Promise<Response> {
  const asset = await fetchUnconditionalAsset(request, assets, "/app.html");
  const headers = dynamicAssetHeaders(asset);
  headers.set("X-Robots-Tag", "noindex, follow");
  if (request.method === "HEAD") {
    await asset.body?.cancel();
    return new Response(null, { status: asset.status, headers });
  }
  const tags =
    `<title>${escapeShareHtml(metadata.title)}</title>` +
    metadata.tags
      .map(({ kind, key, value }) => `<meta ${kind}="${key}" content="${escapeShareHtml(value)}">`)
      .join("");
  const rewritten = new HTMLRewriter()
    .on(
      "title, meta[name='description'], meta[property^='og:'], meta[name^='twitter:'], link[rel='canonical']",
      {
        element(element) {
          element.remove();
        },
      },
    )
    .on("head", {
      element(element) {
        element.append(tags, { html: true });
      },
    })
    .transform(new Response(asset.body, { status: asset.status, headers }));
  return rewritten;
}
