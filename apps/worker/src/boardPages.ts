import { boardPostIdSchema } from "@tetraboard/protocol";
import { D1BoardReader } from "./adapters/community/boardReads";
import { dynamicAssetHeaders, fetchUnconditionalAsset, readWithinDeadline } from "./htmlAssets";

async function boardDetailStatus(env: Env | undefined, id: string): Promise<number> {
  if (!boardPostIdSchema.safeParse(id).success) return 404;
  if (!env) return 503;
  const detail = await readWithinDeadline(
    () => new D1BoardReader(env.APP_DB).detail(id, null),
    "Published board post unavailable",
  );
  if (detail === undefined) return 503;
  return detail ? 200 : 404;
}

export async function serveBoardHtml(request: Request, assets: Fetcher, env?: Env, id?: string) {
  const [asset, status] = await Promise.all([
    fetchUnconditionalAsset(request, assets, "/app.html"),
    id === undefined ? 200 : boardDetailStatus(env, id),
  ]);
  const headers = dynamicAssetHeaders(asset);
  headers.set("X-Robots-Tag", "noindex, follow");
  // app.html には robots のメタタグ（noindex,follow）が入っています。
  const responseStatus = asset.ok ? status : asset.status;
  if (request.method === "HEAD") {
    await asset.body?.cancel();
    return new Response(null, { status: responseStatus, headers });
  }
  return new Response(asset.body, { status: responseStatus, headers });
}
