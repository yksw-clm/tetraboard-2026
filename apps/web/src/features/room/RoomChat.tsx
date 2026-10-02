import { AppCard } from "../../shared/ui/AppCard";
import { AppButton } from "../../shared/ui/AppButton";
import { AppTextField } from "../../shared/ui/AppTextField";
import { chatCharacterLimit, countCharacters } from "@tetraboard/protocol";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { AppIcon } from "../../shared/ui/AppIcon";
import { type useRoomChat } from "./useRoomChat";
import { type useRoomTransport } from "./useRoomTransport";
import { type AppTheme } from "../../shared/ui/appTheme";

export function RoomChat({
  chat,
  session,
  visible,
  theme = "default",
}: {
  chat: ReturnType<typeof useRoomChat>;
  session: Pick<
    ReturnType<typeof useRoomTransport>,
    "chatMessages" | "membership" | "authenticated" | "connection"
  >;
  visible: boolean;
  theme?: AppTheme;
}) {
  const log = useRef<HTMLUListElement>(null);
  const pinned = useRef(true);
  const anchor = useRef<{ id: string; offset: number } | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [expandedMessage, setExpandedMessage] = useState<string | null>(null);
  const { chatMessages: messages, membership, authenticated, connection } = session;
  const count = countCharacters(chat.input);
  const canSend =
    authenticated &&
    connection === "接続済み" &&
    !chat.pending &&
    count > 0 &&
    count <= chatCharacterLimit;
  const composing = useRef(false);

  const capturePosition = useCallback(() => {
    const element = log.current;
    if (!element || !visible) return;
    pinned.current = element.scrollHeight - element.clientHeight - element.scrollTop < 24;
    setAtBottom(pinned.current);
    const top = element.getBoundingClientRect().top;
    const first = Array.from(element.children).find(
      (row) => row.getBoundingClientRect().bottom > top,
    );
    anchor.current =
      first instanceof HTMLElement && first.dataset.messageId
        ? { id: first.dataset.messageId, offset: first.getBoundingClientRect().top - top }
        : null;
  }, [visible]);

  function toBottom() {
    const element = log.current;
    if (!element) return;
    pinned.current = true;
    element.scrollTop = element.scrollHeight;
    capturePosition();
  }

  useLayoutEffect(() => {
    const element = log.current;
    if (!element || !visible) return;
    if (pinned.current) element.scrollTop = element.scrollHeight;
    else if (anchor.current) {
      const row = Array.from(element.children).find(
        (child) => child instanceof HTMLElement && child.dataset.messageId === anchor.current!.id,
      );
      if (row)
        element.scrollTop +=
          row.getBoundingClientRect().top -
          element.getBoundingClientRect().top -
          anchor.current.offset;
      else element.scrollTop = 0;
    }
    capturePosition();
  }, [messages, visible, chat.hiddenSenders, expandedMessage, capturePosition]);

  useLayoutEffect(() => {
    const element = log.current;
    if (!element || !visible) return;
    const observer = new ResizeObserver(() => {
      if (pinned.current) element.scrollTop = element.scrollHeight;
      capturePosition();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [visible, capturePosition]);

  return (
    <AppCard
      density="compact"
      className="flex flex-col h-full min-h-0 [&>h2]:text-base [&>h2]:font-[750] [@media(max-width:1279px)]:max-w-[720px] [@media(max-width:1279px)]:mx-auto"
    >
      <h2>チャット</h2>
      <div className="flex-1 min-h-0 relative flex">
        <ul
          ref={log}
          className="flex-1 min-h-0 overflow-y-auto overscroll-contain [overflow-anchor:none] p-3 m-0 border border-solid border-line rounded-panel list-none [scrollbar-width:thin]"
          onScroll={capturePosition}
          aria-label="チャット履歴"
          tabIndex={0}
        >
          {messages.length === 0 && (
            <li className="text-muted text-xs text-center pt-6">まだメッセージはありません</li>
          )}
          {messages.map((message) => {
            if (message.kind === "system")
              return (
                <li
                  key={message.id}
                  data-message-id={message.id}
                  className="text-center text-muted text-[11px] leading-[1.7] mt-2 mb-[14px] wrap-anywhere"
                >
                  {message.text}
                </li>
              );
            const hidden = chat.hiddenSenders.includes(message.senderId);
            return (
              <li
                key={message.id}
                data-message-id={message.id}
                data-own={message.senderId === membership?.playerId}
                className="mt-0 mb-[14px] group/message"
              >
                <div className="flex items-center gap-[7px] text-[11px] text-muted [&_strong]:text-ink-secondary [&_strong]:wrap-anywhere [&_strong]:min-w-0 [&_time]:ml-auto [&_time]:text-[10px] [&_time]:whitespace-nowrap">
                  <strong>{message.senderName}</strong>
                  <time dateTime={new Date(message.sentAtMs).toISOString()}>
                    {new Intl.DateTimeFormat("ja", { hour: "2-digit", minute: "2-digit" }).format(
                      message.sentAtMs,
                    )}
                  </time>
                  <AppButton
                    size="compact"
                    appearance="quiet"
                    isIconOnly
                    className="h-[22px] min-h-[22px] min-w-[22px] w-[22px] p-0 text-muted font-extrabold"
                    aria-label={`${message.senderName}の発言の操作`}
                    aria-expanded={expandedMessage === message.id}
                    onPress={() =>
                      setExpandedMessage(expandedMessage === message.id ? null : message.id)
                    }
                  >
                    ···
                  </AppButton>
                </div>
                <p
                  className={
                    hidden
                      ? "text-muted text-xs"
                      : `whitespace-pre-wrap wrap-anywhere rounded-[0_12px_12px] py-[7px] px-[10px] text-[13px] ${theme === "four-shogi" ? "bg-surface-muted group-data-[own=true]/message:bg-entry-selection-surface" : "bg-[#f1f5f1] group-data-[own=true]/message:bg-[#e9f4ec]"}`
                  }
                >
                  {hidden ? "この人の発言を非表示中" : message.text}
                </p>
                {expandedMessage === message.id && (
                  <div className="flex gap-1 flex-wrap pt-1 [&>button]:text-[11px] [&>button]:min-h-7 [&>button]:h-auto [&>button]:whitespace-normal">
                    <AppButton
                      size="compact"
                      appearance="quiet"
                      onPress={() => chat.toggleSender(message.senderId)}
                    >
                      {hidden ? "発言を表示" : "この人の発言を非表示"}
                    </AppButton>
                    <AppButton
                      size="compact"
                      appearance="quiet"
                      isDisabled={chat.reporting !== null}
                      onPress={() => void chat.handleReport(message.id)}
                    >
                      通報
                    </AppButton>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        {!atBottom && (
          <AppButton
            size="compact"
            isIconOnly
            className="absolute bottom-[10px] right-[10px] rounded-full bg-white border border-solid border-line text-brand shadow-[0_3px_10px_#13331c20] w-[38px] h-[38px] min-w-[38px] p-0"
            aria-label="最新のメッセージへ"
            onPress={toBottom}
          >
            <AppIcon name="down" />
          </AppButton>
        )}
      </div>
      {chat.error && (
        <p className="text-danger text-xs" role="alert">
          {chat.error}
        </p>
      )}
      {membership ? (
        <form
          className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 items-end"
          onSubmit={chat.handleSubmit}
        >
          <AppTextField
            className="min-w-0 gap-0 [&_input]:min-h-[38px] [&_input]:h-[38px] [&_input]:py-2 [&_input]:px-[10px] [&_input]:text-[13px] [@media(max-width:767px)]:[&_input]:text-base"
            value={chat.input}
            onChange={chat.setInput}
            isInvalid={count > chatCharacterLimit}
          >
            <div className="flex justify-between items-center text-muted text-[10px] mb-[5px] [&_.label]:text-[11px]">
              <AppTextField.Label>メッセージ</AppTextField.Label>
              <span className={count > chatCharacterLimit ? "text-danger text-xs" : ""}>
                {count} / {chatCharacterLimit}
              </span>
            </div>
            <AppTextField.Input
              placeholder="メッセージを入力"
              autoComplete="off"
              onCompositionStart={() => {
                composing.current = true;
              }}
              onCompositionEnd={() => {
                composing.current = false;
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (composing.current || event.nativeEvent.isComposing))
                  event.preventDefault();
              }}
            />
          </AppTextField>
          <AppButton
            size="compact"
            type="submit"
            className="px-[10px] [&_svg]:w-[17px]"
            isDisabled={!canSend}
          >
            <AppIcon name="send" />
            <span>{chat.pending ? "送信中" : "送信"}</span>
          </AppButton>
        </form>
      ) : (
        <p className="text-muted text-xs text-center">観戦中はチャットの閲覧のみできます</p>
      )}
    </AppCard>
  );
}
