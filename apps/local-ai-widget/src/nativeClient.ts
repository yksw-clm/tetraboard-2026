import {
  nativeHostName,
  nativeResponseSchema,
  type NativeResponse,
  type ServiceCommand,
} from "./serviceProtocol";

const setupError =
  "AI起動の初回登録が必要です。導入案内のsetup:nativeを実行し、拡張と対局ページを再読み込みしてください";

export function createNativeClient(runtime: typeof chrome.runtime) {
  let port: chrome.runtime.Port | null = null;
  const pending = new Map<
    string,
    {
      resolve: (response: NativeResponse) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  function reset() {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(Error(setupError));
    }
    pending.clear();
    const previous = port;
    port = null;
    previous?.disconnect();
  }
  return async (command: ServiceCommand): Promise<NativeResponse> => {
    if (!port) {
      try {
        port = runtime.connectNative(nativeHostName);
      } catch {
        throw Error(setupError);
      }
      const connected = port;
      connected.onMessage.addListener((message: unknown) => {
        if (port !== connected) return;
        const parsed = nativeResponseSchema.safeParse(message);
        if (!parsed.success) {
          reset();
          return;
        }
        const entry = pending.get(parsed.data.id);
        if (!entry) return;
        pending.delete(parsed.data.id);
        clearTimeout(entry.timer);
        entry.resolve(parsed.data);
      });
      connected.onDisconnect.addListener(() => {
        // lastErrorを読み取り、Chromeの未処理エラー表示を防ぎます。
        void runtime.lastError;
        if (port === connected) reset();
      });
    }
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(reset, 12000);
      pending.set(id, { resolve, reject, timer });
      try {
        port!.postMessage({ id, command });
      } catch {
        reset();
      }
    });
  };
}
