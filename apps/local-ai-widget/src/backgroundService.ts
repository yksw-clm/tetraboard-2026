import {
  analysisRequestSchema,
  continuousRequestSchema,
  continuousProfile,
  supportedUrl,
} from "./model";
export function createBackground(
  api: typeof chrome,
  fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = fetch,
) {
  const base = "http://127.0.0.1:3002";
  const init = api.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  type Job = { tab: number; id: string; version: 1 | 2 };
  const parseJob = (value: unknown): Job | null => {
    if (!value || typeof value !== "object") return null;
    const v = value as Partial<Job>;
    return typeof v.tab === "number" &&
      typeof v.id === "string" &&
      (v.version === 1 || v.version === 2)
      ? (v as Job)
      : null;
  };
  let current: Job | null = null;
  let serial = Promise.resolve();
  async function cancel() {
    const saved = (await api.storage.session.get("activeAnalysis")).activeAnalysis;
    const previous = current ?? parseJob(saved);
    current = null;
    await api.storage.session.remove("activeAnalysis");
    if (previous) {
      const { token } = await api.storage.local.get("token");
      await fetcher(`${base}/v${previous.version}/analysis/${previous.id}`, {
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
      const health = (await response.json()) as { analysis_versions?: number[]; games?: string[] };
      if (!health.analysis_versions?.includes(2) || !health.games?.includes("four-shogi"))
        throw Error(
          "ローカルAIの更新が必要です。サービスを停止し、serve:localで起動し直してください",
        );
      return { ok: true };
    }
    if (message.type === "poll" && "requestId" in message) {
      const id = message.requestId;
      if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id)) throw Error("要求が不正です");
      const saved =
        current ?? parseJob((await api.storage.session.get("activeAnalysis")).activeAnalysis);
      if (saved?.tab !== tab || saved.id !== id || saved.version !== 2)
        throw Error("解析対象が変更されました。再解析してください");
      const response = await fetcher(`${base}/v2/analysis/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(4000),
      });
      if (!response.ok) throw Error("解析の進捗を取得できません。再解析してください");
      return { ok: true, data: await response.json() };
    }
    if (message.type === "start" && "request" in message) {
      const request = continuousRequestSchema.parse(message.request);
      if (request.profile_hash !== continuousProfile(request.input.game).hash)
        throw Error("解析AIの設定が一致しません");
      const job = await ordered(async () => {
        await cancel();
        if ((await api.storage.session.get("activeTabId")).activeTabId !== tab)
          throw Error("解析タブが変更されました");
        current = { tab, id: request.request_id, version: 2 };
        await api.storage.session.set({ activeAnalysis: current });
        return current;
      });
      try {
        const response = await fetcher(`${base}/v2/analysis`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok)
          throw Error(
            response.status === 401
              ? "ローカルtokenが一致しません"
              : response.status === 503
                ? "ローカルAIが処理中です。再解析してください"
                : "解析を開始できません。サービスの対応版と要求を確認してください",
          );
        return { ok: true, data: await response.json() };
      } catch (error) {
        // 開始応答を失った場合も、開始済みかもしれない探索へ停止を伝えます。
        await ordered(async () => {
          if (current === job) await cancel();
        });
        throw error;
      }
    }
    if (message.type !== "analyze" || !("request" in message)) throw Error("要求が不正です");
    const parsed = analysisRequestSchema.safeParse(message.request);
    if (!parsed.success) throw Error("解析要求が不正です");
    const request = parsed.data;
    const job = await ordered(async () => {
      await cancel();
      const active = await api.storage.session.get("activeTabId");
      if (active.activeTabId !== tab) throw Error("解析タブが変更されました");
      current = { tab, id: request.request_id, version: 1 };
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
