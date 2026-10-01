import { Button, Card, Input, Label, TextField } from "@heroui/react";
import { chatCharacterLimit, countCharacters } from "@tetraboard/protocol";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { RoomIcon } from "./RoomIcon";
import { type useRoomChat } from "./useRoomChat";
import { type useRoomSession } from "./useRoomSession";

export function RoomChat({
  chat,
  session,
  visible,
}: {
  chat: ReturnType<typeof useRoomChat>;
  session: ReturnType<typeof useRoomSession>;
  visible: boolean;
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
    <Card className="room-chat">
      <h2>チャット</h2>
      <div className="room-chat-history">
        <ul
          ref={log}
          className="room-chat-log"
          onScroll={capturePosition}
          aria-label="チャット履歴"
          tabIndex={0}
        >
          {messages.length === 0 && <li className="room-chat-empty">まだメッセージはありません</li>}
          {messages.map((message) => {
            if (message.kind === "system")
              return (
                <li key={message.id} data-message-id={message.id} className="room-system-message">
                  {message.text}
                </li>
              );
            const hidden = chat.hiddenSenders.includes(message.senderId);
            return (
              <li
                key={message.id}
                data-message-id={message.id}
                className={`room-chat-message${message.senderId === membership?.playerId ? " is-own" : ""}`}
              >
                <div className="room-chat-meta">
                  <strong>{message.senderName}</strong>
                  <time dateTime={new Date(message.sentAtMs).toISOString()}>
                    {new Intl.DateTimeFormat("ja", { hour: "2-digit", minute: "2-digit" }).format(
                      message.sentAtMs,
                    )}
                  </time>
                  <Button
                    size="sm"
                    variant="ghost"
                    isIconOnly
                    className="room-message-menu"
                    aria-label={`${message.senderName}の発言の操作`}
                    aria-expanded={expandedMessage === message.id}
                    onPress={() =>
                      setExpandedMessage(expandedMessage === message.id ? null : message.id)
                    }
                  >
                    ···
                  </Button>
                </div>
                <p className={hidden ? "room-muted" : "room-message-text"}>
                  {hidden ? "この人の発言を非表示中" : message.text}
                </p>
                {expandedMessage === message.id && (
                  <div className="room-message-actions">
                    <Button
                      size="sm"
                      variant="ghost"
                      onPress={() => chat.toggleSender(message.senderId)}
                    >
                      {hidden ? "発言を表示" : "この人の発言を非表示"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      isDisabled={chat.reporting !== null}
                      onPress={() => void chat.handleReport(message.id)}
                    >
                      通報
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        {!atBottom && (
          <Button
            isIconOnly
            className="room-scroll-bottom"
            aria-label="最新のメッセージへ"
            onPress={toBottom}
          >
            <RoomIcon name="down" />
          </Button>
        )}
      </div>
      {chat.error && (
        <p className="room-error" role="alert">
          {chat.error}
        </p>
      )}
      {membership ? (
        <form className="room-chat-form" onSubmit={chat.handleSubmit}>
          <TextField
            className="room-chat-field"
            value={chat.input}
            onChange={chat.setInput}
            isInvalid={count > chatCharacterLimit}
          >
            <div className="room-chat-label">
              <Label>メッセージ</Label>
              <span className={count > chatCharacterLimit ? "room-error" : ""}>
                {count} / {chatCharacterLimit}
              </span>
            </div>
            <Input
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
          </TextField>
          <Button
            type="submit"
            className="room-button room-button-primary room-chat-send"
            isDisabled={!canSend}
          >
            <RoomIcon name="send" />
            <span>{chat.pending ? "送信中" : "送信"}</span>
          </Button>
        </form>
      ) : (
        <p className="room-chat-readonly">観戦中はチャットの閲覧のみできます</p>
      )}
    </Card>
  );
}
