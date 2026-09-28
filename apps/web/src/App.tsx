import { healthzContract } from "@tetraboard/protocol";
import { useEffect, useState } from "react";

type ApiStatus = "確認中" | "OK" | "接続失敗";

export function App() {
  const [apiStatus, setApiStatus] = useState<ApiStatus>("確認中");

  useEffect(() => {
    const controller = new AbortController();

    async function checkHealth(): Promise<void> {
      try {
        const response = await fetch(`/api${healthzContract.path}`, {
          cache: "no-store",
          method: healthzContract.method,
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error("Health check failed");
        }

        const body: unknown = await response.json();
        healthzContract.response.parse(body);

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
