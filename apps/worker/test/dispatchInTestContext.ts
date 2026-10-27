import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/worker";

// 並行API処理をRunnerのI/O文脈で開始し、各要求のwaitUntilも回収します。
// 実D1/DOの排他を検証し、別requestの寿命・I/O所有権は検証しません。
export async function dispatchInTestContext(request: Request): Promise<Response> {
  const context = createExecutionContext();
  const response = await worker.fetch(request, env, context);
  await waitOnExecutionContext(context);
  return response;
}
