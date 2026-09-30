import { type ChatMessage, type RoomMembership } from "@tetraboard/protocol";
import { type FormEvent } from "react";

type Props = {
  messages: ChatMessage[];
  membership: RoomMembership | null;
  authenticated: boolean;
  connection: string;
  input: string;
  error: string | null;
  reporting: string | null;
  hiddenSenders: string[];
  onInputChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onToggleSender: (senderId: string) => void;
  onReport: (messageId: string) => void;
};

export function RoomChat({
  messages,
  membership,
  authenticated,
  connection,
  input,
  error,
  reporting,
  hiddenSenders,
  onInputChange,
  onSubmit,
  onToggleSender,
  onReport,
}: Props) {
  return (
    <section aria-label="ルームチャット">
      <h2>チャット</h2>
      {error && <p>{error}</p>}
      <ul>
        {messages.map((message) => (
          <li key={message.id}>
            {hiddenSenders.includes(message.senderId)
              ? `${message.senderName}の発言を非表示中`
              : `${message.senderName}: ${message.text}`}
            <button type="button" onClick={() => onToggleSender(message.senderId)}>
              {hiddenSenders.includes(message.senderId) ? "表示" : "非表示"}
            </button>
            <button
              type="button"
              disabled={reporting !== null}
              onClick={() => onReport(message.id)}
            >
              通報
            </button>
          </li>
        ))}
      </ul>
      {membership !== null && (
        <form onSubmit={onSubmit}>
          <label htmlFor="chat-message">メッセージ</label>
          <input
            id="chat-message"
            value={input}
            onChange={(event) => onInputChange(event.target.value)}
          />
          <button type="submit" disabled={!authenticated || connection !== "接続済み"}>
            送信
          </button>
        </form>
      )}
    </section>
  );
}
