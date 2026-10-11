import { useCallback, useContext } from "react";
import { AccountContext } from "./useAccount";
import {
  accountRequestGeneration,
  isCurrentAccountRequest,
  StaleAccountRequestError,
} from "./accountRequestScope";

export function useAccountDataRequest() {
  const account = useContext(AccountContext);
  const recover = account?.recoverUnauthorized;
  const request = useCallback(
    async (path: string, signal: AbortSignal) => {
      let generation = accountRequestGeneration();
      const fetchCurrent = async () => {
        try {
          return await fetch(path, { credentials: "same-origin", cache: "no-store", signal });
        } catch (error) {
          if (!isCurrentAccountRequest(generation, signal)) throw new StaleAccountRequestError();
          throw error;
        }
      };
      let response = await fetchCurrent();
      if (!isCurrentAccountRequest(generation, signal)) throw new StaleAccountRequestError();
      if (response.status === 401 && recover) {
        const result = await recover(generation);
        if (signal.aborted || result.status === "stale" || result.status === "signed-out")
          throw new StaleAccountRequestError();
        if (result.status !== "authenticated") throw new Error("Session verification failed");
        generation = result.generation;
        if (!isCurrentAccountRequest(generation, signal)) throw new StaleAccountRequestError();
        // 同じ操作の自動再取得は一度だけにします。
        response = await fetchCurrent();
        if (!isCurrentAccountRequest(generation, signal)) throw new StaleAccountRequestError();
      }
      return { response, generation };
    },
    [recover],
  );
  return { request, generation: account?.generation };
}
