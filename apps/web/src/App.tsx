import { useEffect, useState } from "react";

type ApiStatus = "確認中" | "OK" | "接続失敗";

export function App() {
  const [apiStatus, setApiStatus] = useState<ApiStatus>("確認中");

  useEffect(() => {
    const controller = new AbortController();

    async function checkHealth(): Promise<void> {
      try {
        const response = await fetch("/api/healthz", {
          cache: "no-store",
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error("Health check failed");
        }

        const body: unknown = await response.json();
        if (
          typeof body !== "object" ||
          body === null ||
          !("status" in body) ||
          body.status !== "ok"
        ) {
          throw new Error("Unexpected health response");
        }

        if (!controller.signal.aborted) {
          setApiStatus("OK");
        }
      } catch {
        if (!controller.signal.aborted) {
          setApiStatus("接続失敗");
        }
      }
    }

    void checkHealth();
    return () => controller.abort();
  }, []);

  return <p>APIステータス：{apiStatus}</p>;
}
