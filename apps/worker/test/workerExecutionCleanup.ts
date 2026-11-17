import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/worker";
import { CleanupDeadline, cleanupTimeoutMs } from "./cleanupDeadline";

// ネイティブfetchとハンドラー直接呼出しの両方で、後片づけより先にwaitUntilを回収します。
export function trackWorkerExecutions(): () => Promise<void> {
  const fetch = worker.fetch;
  const pending = createExecutionContext();
  worker.fetch = (request, env, context) =>
    fetch.call(
      worker,
      request,
      env,
      new Proxy(context, {
        get(target, key) {
          if (key === "waitUntil")
            return (promise: Promise<unknown>) => {
              pending.waitUntil(promise);
              target.waitUntil(promise);
            };
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    );
  return async () => {
    try {
      const limit = new CleanupDeadline(cleanupTimeoutMs, () => "Worker execution cleanup");
      await limit.wait(
        () => "Worker waitUntil",
        () => waitOnExecutionContext(pending),
      );
    } finally {
      worker.fetch = fetch;
    }
  };
}
