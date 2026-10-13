import { useState } from "react";
import { Button, Card } from "@heroui/react";
import {
  lobbyAdminSchema,
  lobbyChatSchema,
  type LobbyModeration,
} from "@tetraboard/protocol/general-lobby";

import { useAdminData } from "./useAdminData";
const parseAdmin = (value: unknown) => lobbyAdminSchema.parse(value);
const parseChat = (value: unknown) => lobbyChatSchema.parse(value);
export function LobbyChat() {
  const page = useAdminData("/api/admin/lobby-chat", parseAdmin),
    chat = useAdminData("/api/lobby/chat?limit=500", parseChat);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<LobbyModeration | null>(null);
  function operate(input: LobbyModeration) {
    if (!busy) setConfirmation(input);
  }
  async function execute(input: LobbyModeration) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/lobby-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!response.ok) throw new Error("変更できませんでした。再試行してください。");
      setConfirmation(null);
      page.refresh();
      chat.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "変更できませんでした。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-bold">公開チャット（β）</h1>
      {confirmation && (
        <Card className="gap-3 p-5">
          <p>
            選択した操作（
            {confirmation.action === "delete"
              ? "投稿を削除"
              : confirmation.action === "stop"
                ? confirmation.stopped
                  ? "この人の投稿を停止"
                  : "投稿停止を解除"
                : confirmation.action === "accepting"
                  ? confirmation.accepting
                    ? "全体の投稿受付を再開"
                    : "全体の投稿受付を停止"
                  : "通報を対応済みに変更"}
            ）を実行しますか？
          </p>
          <div className="flex gap-2">
            <Button isDisabled={busy} isPending={busy} onPress={() => void execute(confirmation)}>
              実行
            </Button>
            <Button isDisabled={busy} onPress={() => setConfirmation(null)}>
              取り消す
            </Button>
          </div>
        </Card>
      )}
      {(page.error || chat.error || error) && (
        <p role="alert">{error ?? page.error ?? chat.error}</p>
      )}
      <Button
        onPress={() => {
          page.refresh();
          chat.refresh();
        }}
        isDisabled={busy || page.loading || chat.loading}
      >
        更新・再試行
      </Button>
      {page.data && (
        <>
          <Card className="gap-3 p-5">
            <h2 className="text-lg font-bold">投稿受付</h2>
            <p>{page.data.acceptingPosts ? "受付中" : "停止中（閲覧・対局は利用可能）"}</p>
            <Button
              isDisabled={busy}
              onPress={() =>
                void operate({ action: "accepting", accepting: !page.data!.acceptingPosts })
              }
            >
              {page.data.acceptingPosts ? "投稿受付を停止" : "投稿受付を再開"}
            </Button>
          </Card>
          <Card className="gap-3 p-5">
            <h2 className="text-lg font-bold">投稿停止中の利用者</h2>
            {page.data.stoppedSenders.length === 0 && <p>投稿停止中の利用者はいません。</p>}
            {page.data.stoppedSenders.map((s) => (
              <div key={s.senderId} className="flex items-center justify-between gap-3">
                <span>{s.senderName}</span>
                <Button
                  isDisabled={busy}
                  onPress={() =>
                    void operate({ action: "stop", senderId: s.senderId, stopped: false })
                  }
                >
                  停止を解除
                </Button>
              </div>
            ))}
          </Card>
          <Card className="gap-3 p-5">
            <h2 className="text-lg font-bold">通報（7日以内）</h2>
            {page.data.reports.length === 0 && <p>通報はありません。</p>}
            {page.data.reports.map((r) => (
              <article key={r.id} className="flex flex-col gap-2 border-b border-gray-200 py-3">
                <p>
                  {r.senderName} · {new Date(r.sentAtMs).toLocaleString("ja")} ·{" "}
                  {r.status === "resolved" ? "対応済み" : "未対応"}
                </p>
                <p className="whitespace-pre-wrap break-words">{r.text}</p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    isDisabled={busy}
                    onPress={() => void operate({ action: "delete", messageId: r.messageId })}
                  >
                    投稿を削除
                  </Button>
                  {r.senderId && (
                    <Button
                      isDisabled={busy}
                      onPress={() =>
                        void operate({ action: "stop", senderId: r.senderId!, stopped: true })
                      }
                    >
                      投稿を停止
                    </Button>
                  )}
                  <Button
                    isDisabled={busy || r.status === "resolved"}
                    onPress={() => void operate({ action: "resolve", reportId: r.id })}
                  >
                    対応済みにする
                  </Button>
                </div>
              </article>
            ))}
          </Card>
        </>
      )}
      <Card className="gap-3 p-5">
        <h2 className="text-lg font-bold">現在の公開投稿</h2>
        {chat.loading && <p role="status">読み込んでいます…</p>}
        {chat.data?.messages.map((m) => (
          <article key={m.id} className="flex flex-col gap-2 border-b border-gray-200 py-3">
            <p>
              {m.senderName} · {new Date(m.sentAtMs).toLocaleString("ja")}
            </p>
            <p className="whitespace-pre-wrap break-words">{m.text}</p>
            <div className="flex gap-2">
              <Button
                isDisabled={busy}
                onPress={() => void operate({ action: "delete", messageId: m.id })}
              >
                投稿を削除
              </Button>
              <Button
                isDisabled={busy}
                onPress={() =>
                  void operate({ action: "stop", senderId: m.senderId, stopped: true })
                }
              >
                投稿を停止
              </Button>
            </div>
          </article>
        ))}
      </Card>
    </div>
  );
}
