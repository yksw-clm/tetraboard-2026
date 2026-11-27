import {
  boardTextLength,
  boardTextLimit,
  type BoardAttachment as Attachment,
  type BoardPostInput,
} from "@tetraboard/protocol/board";
import type { GameId } from "@tetraboard/protocol/games";
import { useId, useRef, useState, type FormEvent } from "react";
import { createUuid } from "../../shared/createUuid";
import { AppAvatar } from "../../shared/ui/AppAvatar";
import { AppButton, AppButtonLink } from "../../shared/ui/AppButton";
import { AppCard } from "../../shared/ui/AppCard";
import type { RegistrationDestination } from "../account/registrationReturn";
import { useAccount } from "../account/useAccount";
import { mutationError } from "./boardApi";
import { BoardAttachment } from "./BoardAttachment";
import { BoardAttachmentPicker } from "./BoardAttachmentPicker";
import { BoardLinkDialog } from "./BoardLinkDialog";
import type { BoardWrite } from "./useBoardData";

type Props = {
  posting: { acceptingPosts: boolean; postingStopped: boolean };
  returnTo: string;
  placeholder: string;
  initialText?: string;
  reply?: boolean;
  busy: boolean;
  write: BoardWrite;
  attachmentEditor?: {
    game: GameId;
    value: Attachment | null;
    onChange: (value: Attachment | null) => void;
  };
  onSubmit: (input: BoardPostInput, signal: AbortSignal) => Promise<void>;
};

export function BoardComposer({
  posting,
  returnTo,
  placeholder,
  initialText = "",
  reply,
  busy,
  write,
  attachmentEditor,
  onSubmit,
}: Props) {
  const account = useAccount();
  const description = useId();
  const [accountChecked, setAccountChecked] = useState(!account.loading);
  if (!accountChecked && !account.loading) setAccountChecked(true);
  const [text, setText] = useState(initialText);
  const [linkDestination, setLinkDestination] = useState<RegistrationDestination | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickerAttachmentKey, setPickerAttachmentKey] = useState<string | null>(null);
  const [attachmentRevision, setAttachmentRevision] = useState(0);
  const request = useRef<{ id: string; attachmentKey: string } | null>(null);
  const composing = useRef(false);
  const count = boardTextLength(text);
  const canSubmit = count > 0 && count <= boardTextLimit;
  const submitLabel = reply ? "返信する" : "投稿する";
  const unlinked = !account.user || account.user.isGuest;
  const checkingAccount = !accountChecked && account.loading && !account.user;
  const requiresSetup = !unlinked && !account.user?.profileCompleted;
  const canCompose =
    posting.acceptingPosts &&
    !posting.postingStopped &&
    !account.error &&
    !checkingAccount &&
    !requiresSetup;
  const attachment = attachmentEditor?.value ?? null;
  const attachmentKey = JSON.stringify(attachment);
  const pickerOpen = canCompose && !busy && !pending && pickerAttachmentKey === attachmentKey;
  if (pickerAttachmentKey !== null && !pickerOpen) setPickerAttachmentKey(null);
  const activeLink =
    canCompose &&
    unlinked &&
    canSubmit &&
    linkDestination?.path === returnTo &&
    linkDestination.boardDraft?.text === text
      ? linkDestination
      : null;
  if (linkDestination && !activeLink) setLinkDestination(null);

  function submit(event?: FormEvent) {
    event?.preventDefault();
    if (
      !canCompose ||
      busy ||
      pending ||
      activeLink ||
      pickerOpen ||
      composing.current ||
      !canSubmit
    )
      return;
    if (unlinked) {
      setLinkDestination({ path: returnTo, boardDraft: { kind: reply ? "reply" : "post", text } });
      return;
    }
    void write(async (signal) => {
      setPending(true);
      setError(null);
      try {
        if (request.current?.attachmentKey !== attachmentKey)
          request.current = { attachmentKey, id: createUuid() };
        await onSubmit(
          { text, requestId: request.current.id, ...(attachment ? { attachment } : {}) },
          signal,
        );
        if (signal.reason?.name === "AbortError") return;
        setText("");
        request.current = null;
        if (attachment) attachmentEditor?.onChange(null);
      } catch (error) {
        setError(mutationError(error, `${reply ? "返信" : "投稿"}を送信できませんでした。`));
      } finally {
        setPending(false);
      }
    });
  }

  let controls;
  if (!posting.acceptingPosts) {
    controls = <p>現在、掲示板への投稿を受け付けていません。投稿は閲覧できます。</p>;
  } else if (posting.postingStopped) {
    controls = <p>このアカウントは掲示板への投稿を停止されています。</p>;
  } else if (account.error) {
    controls = (
      <>
        <p role="alert">{account.error}</p>
        <AppButton
          appearance="secondary"
          isPending={account.pendingSource === "board-retry"}
          isDisabled={account.loading}
          onPress={() => void account.refresh("board-retry")}
        >
          再試行
        </AppButton>
      </>
    );
  } else if (checkingAccount) {
    controls = <p role="status">ログイン状態を確認しています…</p>;
  } else if (requiresSetup) {
    controls = (
      <>
        <p>プロフィールの初回設定を完了すると投稿できます。</p>
        <AppButtonLink to="/account/setup">プロフィールを設定する</AppButtonLink>
      </>
    );
  } else {
    controls = (
      <form className="grid gap-3" onSubmit={submit}>
        <div className="flex min-w-0 items-start gap-2">
          {account.user && <AppAvatar src={account.user.avatarUrl} />}
          <textarea
            rows={3}
            className="min-w-0 flex-1 resize-y rounded-control border border-solid border-line bg-white p-3 text-base text-ink wrap-anywhere focus-visible:outline-[3px] focus-visible:outline-focus"
            aria-label={placeholder}
            aria-describedby={description}
            placeholder={placeholder}
            value={text}
            readOnly={pending}
            onChange={(event) => {
              request.current = null;
              setText(event.currentTarget.value);
            }}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            onKeyDown={(event) => {
              if (
                event.key !== "Enter" ||
                !(event.ctrlKey || event.metaKey) ||
                event.nativeEvent.isComposing ||
                event.keyCode === 229 ||
                composing.current
              )
                return;
              event.preventDefault();
              submit();
            }}
          />
        </div>
        {attachment && <BoardAttachment key={attachmentRevision} {...attachment} />}
        {attachmentEditor && (
          <div className="flex flex-wrap items-center gap-2">
            <AppButton
              appearance="secondary"
              size="compact"
              isDisabled={busy || pending}
              onPress={() => setPickerAttachmentKey(attachmentKey)}
            >
              {attachment ? "変更" : "棋譜を添付"}
            </AppButton>
            {attachment && (
              <AppButton
                appearance="quiet"
                size="compact"
                isDisabled={busy || pending}
                onPress={() => {
                  request.current = null;
                  attachmentEditor.onChange(null);
                }}
              >
                添付を外す
              </AppButton>
            )}
          </div>
        )}
        {error && (
          <p role="alert" className="text-danger">
            {error}
          </p>
        )}
        <div className="flex flex-wrap items-center justify-end gap-3">
          <span id={description} className={count > boardTextLimit ? "text-danger" : "text-muted"}>
            {count}/{boardTextLimit}
          </span>
          <AppButton type="submit" isPending={pending} isDisabled={busy || !canSubmit}>
            {submitLabel}
          </AppButton>
        </div>
      </form>
    );
  }

  return (
    <AppCard className="min-w-0 gap-3 text-sm">
      {controls}
      {attachmentEditor && pickerOpen && (
        <BoardAttachmentPicker
          game={attachmentEditor.game}
          attachment={attachment}
          hasHistory={!!account.user}
          onClose={() => setPickerAttachmentKey(null)}
          onConfirm={(next) => {
            attachmentEditor.onChange(next);
            // 同じ対局を再確定した場合も、取得済みの盤面を読み直します。
            setAttachmentRevision((revision) => revision + 1);
            setPickerAttachmentKey(null);
          }}
        />
      )}
      {activeLink && (
        <BoardLinkDialog destination={activeLink} onClose={() => setLinkDestination(null)} />
      )}
    </AppCard>
  );
}
