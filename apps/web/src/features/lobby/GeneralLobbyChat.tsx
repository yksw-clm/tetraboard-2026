import { useEffect, useRef, useState } from "react";
import { chatCharacterLimit, countCharacters } from "@tetraboard/protocol";
import { AppAvatar } from "../../shared/ui/AppAvatar";
import { AppButton, AppButtonLink } from "../../shared/ui/AppButton";
import { AppCard } from "../../shared/ui/AppCard";
import { AppIcon } from "../../shared/ui/AppIcon";
import { AppSectionHeading } from "../../shared/ui/AppSectionHeading";
import { AppTextField } from "../../shared/ui/AppTextField";
import { useLobbyChat } from "./useLobbyChat";
import { useAccount } from "../account/useAccount";
import { useNavigate } from "react-router";
import { saveRegistrationReturn } from "../account/registrationReturn";
import { AppDialog } from "../../shared/ui/AppDialog";
import { LobbyChatGuestDialog } from "./LobbyChatGuestDialog";
const draftKey = "tetraboard:lobby-chat:draft";
const hiddenKey = "tetraboard:lobby-chat:hidden";
function readDraft() {
  try {
    return sessionStorage.getItem(draftKey) ?? "";
  } catch {
    return "";
  }
}
function readHidden(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(hiddenKey) ?? "[]");
    return Array.isArray(value) && value.every((v) => typeof v === "string") ? value : [];
  } catch {
    return [];
  }
}

export function GeneralLobbyChat() {
  const account = useAccount(),
    navigate = useNavigate();
  const page = useLobbyChat(account.user?.profileId ?? account.user?.username ?? null);
  const messages = page.messages;
  const needsGuest = !account.user || Boolean(account.user.isGuest && !account.user.nameCustomized);
  const hasPostingIdentity = Boolean(account.user?.profileCompleted) && !needsGuest;
  const [guestDialog, setGuestDialog] = useState(false);
  const [input, setInput] = useState(readDraft);
  const [reportId, setReportId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [newCount, setNewCount] = useState(0);
  const [now, setNow] = useState(Date.now);
  const composing = useRef(false);
  const log = useRef<HTMLUListElement>(null);
  const anchors = useRef<{ id: string; offset: number }[]>([]);
  const follow = useRef(true),
    snapshot = useRef<string[]>([]);
  const [received, setReceived] = useState({ server: 0, local: 0 });
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    try {
      sessionStorage.setItem(draftKey, input);
    } catch {
      /* 端末保存を利用できなくても、この画面内の入力は保持します。 */
    }
  }, [input]);
  useEffect(() => {
    // サーバー時刻の更新とスクロール状態を受信した履歴に同期します。
    // eslint-disable-next-line react/set-state-in-effect
    setReceived({ server: page.serverTimeMs, local: Date.now() });
    const count = page.messages.filter((m) => !snapshot.current.includes(m.id)).length;
    snapshot.current = page.messages.map((m) => m.id);
    if (follow.current) {
      if (log.current) log.current.scrollTop = log.current.scrollHeight;
      setNewCount(0);
    } else {
      const element = log.current;
      if (element) {
        for (const anchor of anchors.current) {
          const row = element.querySelector<HTMLElement>(`[data-message-id="${anchor.id}"]`);
          if (row) {
            element.scrollTop = row.offsetTop - anchor.offset;
            break;
          }
        }
      }
      if (count) setNewCount((n) => n + count);
    }
  }, [page.messages, page.serverTimeMs]);
  function onSignIn() {
    saveRegistrationReturn({ path: "/" }, false);
    void navigate(account.user ? "/account/setup" : "/login");
  }
  const remaining = Math.max(
    0,
    Math.ceil((page.availableAtMs - (received.server + now - received.local)) / 1000),
  );
  const blocked =
    page.sending ||
    account.loading ||
    Boolean(account.error) ||
    page.loading ||
    !page.acceptingPosts ||
    page.postingStopped ||
    remaining > 0;
  const [expanded, setExpanded] = useState<string | null>(null);
  const [hiddenSenders, setHiddenSenders] = useState<string[]>(readHidden);
  const count = countCharacters(input.trim());
  const valid = count > 0 && count <= chatCharacterLimit;

  return (
    <section
      aria-labelledby="public-chat-title"
      className="min-w-0 [@media(min-width:768px)]:row-span-3 [@media(min-width:768px)]:grid [@media(min-width:768px)]:grid-rows-subgrid"
    >
      <div className="flex min-w-0 flex-col justify-between">
        <AppSectionHeading
          id="public-chat-title"
          title="公開チャット（β）"
          description="現在β版として試験公開しています。"
        />
        <AppButtonLink
          to="/feedback"
          size="compact"
          appearance="quiet"
          className="mb-2.5 self-start px-0 text-xs"
        >
          <AppIcon name="chat" className="size-3.5" />
          使ってみた感想を送る
        </AppButtonLink>
      </div>
      <AppCard className="h-[600px] min-h-0 gap-3 p-4 [@media(min-width:768px)]:h-full">
        <ul
          ref={log}
          onScroll={() => {
            if (log.current)
              anchors.current = [...log.current.querySelectorAll<HTMLElement>("[data-message-id]")]
                .filter((row) => row.offsetTop + row.offsetHeight >= log.current!.scrollTop)
                .slice(0, 10)
                .map((row) => ({
                  id: row.dataset.messageId!,
                  offset: row.offsetTop - log.current!.scrollTop,
                }));
            if (log.current)
              follow.current =
                log.current.scrollHeight - log.current.scrollTop - log.current.clientHeight < 40;
          }}
          aria-label="公開チャット履歴"
          tabIndex={0}
          className="m-0 min-h-0 flex-1 list-none overflow-y-auto overscroll-contain rounded-panel border border-solid border-line p-2.5 [scrollbar-width:thin]"
        >
          {page.loading && (
            <li role="status" className="text-xs text-muted">
              チャットを読み込んでいます…
            </li>
          )}
          {page.nextCursor && (
            <li>
              <AppButton
                size="compact"
                appearance="quiet"
                isDisabled={page.loading}
                onPress={() => {
                  follow.current = false;
                  const height = log.current?.scrollHeight ?? 0;
                  void page.loadMore().then(() =>
                    requestAnimationFrame(() => {
                      if (log.current) log.current.scrollTop += log.current.scrollHeight - height;
                    }),
                  );
                }}
              >
                以前の発言を見る
              </AppButton>
            </li>
          )}
          {messages.length === 0 && !page.loading && (
            <li className="pt-10 text-center text-xs text-muted">
              まだメッセージはありません。
              <br />
              次に遊ぶ予定を、気軽に書いてみませんか？
            </li>
          )}

          {messages.map((message, index) => {
            const hidden = hiddenSenders.includes(message.senderId);
            return (
              <li
                key={message.id}
                data-message-id={message.id}
                className="border-b border-solid border-line py-1 last:border-0"
              >
                {(index === 0 ||
                  new Date(messages[index - 1].sentAtMs).toDateString() !==
                    new Date(message.sentAtMs).toDateString()) && (
                  <p className="py-2 text-center text-[11px] text-muted">
                    {new Intl.DateTimeFormat("ja", { month: "long", day: "numeric" }).format(
                      message.sentAtMs,
                    )}
                  </p>
                )}
                <div
                  className={`grid grid-cols-[20px_minmax(0,1fr)_34px_20px] items-start gap-1.5 rounded-control px-2 py-1.5 ${message.own ? "bg-[#e9f4ec]" : ""}`}
                >
                  <AppAvatar
                    src={message.avatarUrl}
                    label={`${message.senderName}のアイコン`}
                    className="size-5 [&_svg]:size-3"
                  />
                  <p className="min-w-0 flex-1 text-xs leading-5 wrap-anywhere">
                    <strong className="mr-1.5 font-semibold text-ink-secondary">
                      {message.senderName}
                    </strong>
                    <span className={`whitespace-pre-wrap ${hidden ? "text-muted" : "text-ink"}`}>
                      {hidden ? "この人の発言を非表示中" : message.text}
                    </span>
                  </p>
                  <span
                    title={new Date(message.sentAtMs).toLocaleString("ja")}
                    className="whitespace-nowrap text-right text-[10px] leading-5 text-muted tabular-nums"
                  >
                    {new Intl.DateTimeFormat("ja", { hour: "2-digit", minute: "2-digit" }).format(
                      message.sentAtMs,
                    )}
                  </span>
                  {!message.own ? (
                    <AppButton
                      size="compact"
                      appearance="quiet"
                      isIconOnly
                      className="size-5 min-h-5 min-w-5 p-0 text-muted"
                      aria-label={`${message.senderName}の発言の操作`}
                      aria-expanded={expanded === message.id}
                      onPress={() => setExpanded(expanded === message.id ? null : message.id)}
                    >
                      ···
                    </AppButton>
                  ) : (
                    <span aria-hidden="true" className="size-5" />
                  )}
                </div>
                {expanded === message.id && (
                  <div className="mt-1 ml-7 flex flex-wrap gap-1">
                    <AppButton
                      size="compact"
                      appearance="quiet"
                      className="min-h-7 px-1 text-[11px]"
                      onPress={() => {
                        const next = hidden
                          ? hiddenSenders.filter((sender) => sender !== message.senderId)
                          : [...hiddenSenders, message.senderId];
                        setHiddenSenders(next);
                        try {
                          localStorage.setItem(hiddenKey, JSON.stringify(next));
                        } catch {
                          /* この画面内では非表示を継続します。 */
                        }
                      }}
                    >
                      {hidden ? "発言を表示" : "この人の発言を非表示"}
                    </AppButton>
                    <AppButton
                      size="compact"
                      appearance="quiet"
                      className="min-h-7 px-1 text-[11px]"
                      isDisabled={!account.user || page.reporting}
                      onPress={() => setReportId(message.id)}
                    >
                      通報
                    </AppButton>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        {page.error && (
          <p role="alert" className="text-xs text-danger">
            {page.error}{" "}
            <AppButton size="compact" appearance="quiet" onPress={page.refresh}>
              再試行
            </AppButton>
          </p>
        )}
        {notice && (
          <p role="status" className="text-xs text-brand">
            {notice}
          </p>
        )}
        {newCount > 0 && (
          <AppButton
            size="compact"
            appearance="quiet"
            onPress={() => {
              follow.current = true;
              setNewCount(0);
              if (log.current) log.current.scrollTop = log.current.scrollHeight;
            }}
          >
            新着{newCount}件・最新へ
          </AppButton>
        )}
        {(!page.acceptingPosts || page.postingStopped) && (
          <p role="status" className="text-xs text-muted">
            現在、公開チャットへの投稿は停止されています。
          </p>
        )}
        {hasPostingIdentity ? (
          <form
            className="flex shrink-0 flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (!valid || blocked || composing.current) return;
              const sent = input.trim();
              void page.send(sent).then((ok) => {
                if (ok) {
                  setInput((current) => (current.trim() === sent ? "" : current));
                  follow.current = true;
                  setNewCount(0);
                  if (log.current) log.current.scrollTop = log.current.scrollHeight;
                }
              });
            }}
          >
            <AppTextField
              value={input}
              onChange={setInput}
              isInvalid={count > chatCharacterLimit}
              className="gap-1"
            >
              <div className="flex items-center justify-between gap-2">
                <AppTextField.Label>メッセージ</AppTextField.Label>
                <span
                  className={`text-[11px] ${count > chatCharacterLimit ? "text-danger" : "text-muted"}`}
                >
                  {count} / {chatCharacterLimit}
                </span>
              </div>
              <div className="grid grid-cols-[minmax(0,1fr)_auto] items-stretch gap-2">
                <AppTextField.Input
                  placeholder="何時から、何のゲームで遊びますか？"
                  autoComplete="off"
                  onCompositionStart={() => {
                    composing.current = true;
                  }}
                  onCompositionEnd={() => {
                    composing.current = false;
                  }}
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      (composing.current || event.nativeEvent.isComposing)
                    )
                      event.preventDefault();
                  }}
                  className="h-12 min-h-12 px-2.5 py-0 text-[13px] [@media(max-width:767px)]:text-base"
                />
                <AppButton
                  size="compact"
                  type="submit"
                  className="h-12 min-h-12"
                  isDisabled={!valid || blocked}
                  isPending={page.sending}
                >
                  <AppIcon name="send" className="size-4" />
                  送信
                </AppButton>
              </div>
            </AppTextField>
          </form>
        ) : (
          <div className="flex shrink-0 flex-col items-center gap-2 rounded-control bg-surface-muted px-3 py-4">
            <p className="text-xs text-muted">
              {account.loading
                ? "アカウントを確認しています…"
                : needsGuest
                  ? "ゲストでも名前を設定すると投稿できます。"
                  : "投稿にはプロフィール設定が必要です。"}
            </p>
            {account.error && (
              <p role="alert" className="text-xs text-danger">
                {account.error}
              </p>
            )}
            <AppButton
              size="compact"
              isDisabled={
                account.loading ||
                (!account.error && (page.loading || !page.acceptingPosts || page.postingStopped))
              }
              onPress={() => {
                if (account.error) void account.refresh("chat-identity");
                else if (needsGuest) setGuestDialog(true);
                else onSignIn();
              }}
            >
              {account.error ? "再試行" : needsGuest ? "名前を設定して投稿" : "プロフィールを設定"}
            </AppButton>
          </div>
        )}
      </AppCard>
      {guestDialog && needsGuest && <LobbyChatGuestDialog onClose={() => setGuestDialog(false)} />}
      {reportId && (
        <AppDialog
          title="メッセージを通報"
          size="compact"
          busy={page.reporting}
          onClose={() => setReportId(null)}
        >
          <p className="mb-4 text-sm">この発言を運営に通報しますか？</p>
          <AppButton
            isPending={page.reporting}
            isDisabled={page.reporting}
            onPress={() => {
              void page.report(reportId).then((ok) => {
                if (ok) {
                  setReportId(null);
                  setNotice("通報を受け付けました。");
                }
              });
            }}
          >
            通報する
          </AppButton>
        </AppDialog>
      )}
    </section>
  );
}
