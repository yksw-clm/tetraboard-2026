import { analysisRequestSchema, supportedUrl } from "./model";
export function createBackground(api: typeof chrome, fetcher: typeof fetch = fetch) {
  const base = "http://127.0.0.1:3002";
  const init = api.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  let current: { tab: number; id: string } | null = null;
  let serial = Promise.resolve();
  async function cancel() {
    const previous = current;
    current = null;
    if (previous) {
      const { token } = await api.storage.local.get("token");
      await fetcher(`${base}/v1/analysis/${previous.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token ?? ""}` },
        signal: AbortSignal.timeout(4000),
      }).catch(() => {});
    }
  }
  function ordered<T>(fn: () => Promise<T>): Promise<T> {
    const next = serial.then(fn);
    serial = next.then(
      () => {},
      () => {},
    );
    return next;
  }
  async function handle(message: unknown, sender: chrome.runtime.MessageSender): Promise<unknown> {
    await init;
    if (!sender.tab?.id || !sender.url || !supportedUrl(sender.url) || sender.frameId !== 0)
      throw Error("許可されていない画面です");
    const tab = sender.tab.id;
    if (!message || typeof message !== "object" || !("type" in message))
      throw Error("要求が不正です");
    if (message.type === "position") {
      if ("position" in message) {
        const p = message.position as { left?: unknown; top?: unknown };
        if (
          typeof p?.left !== "string" ||
          typeof p.top !== "string" ||
          !/^\d+(?:\.\d+)?px$/.test(p.left) ||
          !/^\d+(?:\.\d+)?px$/.test(p.top)
        )
          throw Error("位置が不正です");
        await api.storage.local.set({ widgetPosition: { left: p.left, top: p.top } });
      }
      return { ok: true, data: (await api.storage.local.get("widgetPosition")).widgetPosition };
    }
    if (message.type === "enable")
      return ordered(async () => {
        const { activeTabId } = await api.storage.session.get("activeTabId");
        await cancel();
        await api.storage.session.set({ activeTabId: tab });
        if (typeof activeTabId === "number" && activeTabId !== tab)
          await api.tabs.sendMessage(activeTabId, { type: "revoked" }).catch(() => {});
        return { ok: true };
      });
    if (message.type === "cancel" || message.type === "disable")
      return ordered(async () => {
        const { activeTabId } = await api.storage.session.get("activeTabId");
        if (activeTabId === tab) {
          await cancel();
          if (message.type === "disable") await api.storage.session.remove("activeTabId");
        }
        return { ok: true };
      });
    const { activeTabId } = await api.storage.session.get("activeTabId");
    if (activeTabId !== tab) throw Error("このタブのwidgetは無効です");
    const { token } = await api.storage.local.get("token");
    if (typeof token !== "string" || token.length < 32)
      throw Error("拡張の設定画面でローカルtokenを登録してください");
    if (message.type === "health") {
      const response = await fetcher(`${base}/health`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(4000),
      }).catch(() => {
        throw Error("ローカルAIへ接続できません。解析端末を確認してください");
      });
      if (!response.ok) throw Error("ローカルAIへ接続できません");
      return { ok: true };
    }
    if (message.type !== "analyze" || !("request" in message)) throw Error("要求が不正です");
    const parsed = analysisRequestSchema.safeParse(message.request);
    if (!parsed.success) throw Error("解析要求が不正です");
    const request = parsed.data;
    const job = await ordered(async () => {
      await cancel();
      const active = await api.storage.session.get("activeTabId");
      if (active.activeTabId !== tab) throw Error("解析タブが変更されました");
      current = { tab, id: request.request_id };
      return current;
    });
    try {
      const response = await fetcher(`${base}/v1/analysis`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(5000),
      }).catch(() => {
        throw Error("ローカルAIへ接続できません。起動状態を確認して再解析してください");
      });
      if (!response.ok)
        throw Error(
          response.status === 401
            ? "ローカルtokenが一致しません"
            : response.status === 503
              ? "ローカルAIが処理中です。再解析してください"
              : "解析に失敗しました",
        );
      return { ok: true, data: await response.json() };
    } finally {
      if (current === job) current = null;
    }
  }
  api.tabs.onRemoved.addListener((tab) => {
    void ordered(async () => {
      const { activeTabId } = await api.storage.session.get("activeTabId");
      if (activeTabId === tab) {
        await cancel();
        await api.storage.session.remove("activeTabId");
      }
    });
  });

  return handle;
}
