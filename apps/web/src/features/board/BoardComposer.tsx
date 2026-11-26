import { countCharacters } from "@tetraboard/protocol";
import { useId, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { createUuid } from "../../shared/createUuid";
import { AppButton, AppButtonLink } from "../../shared/ui/AppButton";
import { AppCard } from "../../shared/ui/AppCard";
import { saveRegistrationReturn } from "../account/registrationReturn";
import { useAccount } from "../account/useAccount";
import { mutationError } from "./boardApi";
import type { BoardWrite } from "./useBoardData";

type Props = {
  posting: { acceptingPosts: boolean; postingStopped: boolean };
  returnTo: string;
  placeholder: string;
  reply?: boolean;
  busy: boolean;
  write: BoardWrite;
  onSubmit: (input: { text: string; requestId: string }, signal: AbortSignal) => Promise<void>;
};

const textLimit = 1000;

export function BoardComposer({
  posting,
  returnTo,
  placeholder,
  reply,
  busy,
  write,
  onSubmit,
}: Props) {
  const account = useAccount();
  const navigate = useNavigate();
  const description = useId();
  const [accountChecked, setAccountChecked] = useState(!account.loading);
  if (!accountChecked && !account.loading) setAccountChecked(true);
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef<string | null>(null);
  const composing = useRef(false);
  const count = countCharacters(text);
  const submitLabel = reply ? "返信する" : "投稿する";

  function signIn() {
    saveRegistrationReturn({ path: returnTo }, false);
    void navigate("/login");
  }

  function submit(event?: FormEvent) {
    event?.preventDefault();
    if (busy || pending || composing.current || !text.trim() || count > textLimit) return;
    void write(async (signal) => {
      setPending(true);
      setError(null);
      try {
        requestId.current ??= createUuid();
        await onSubmit({ text, requestId: requestId.current }, signal);
        setText("");
        requestId.current = null;
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
  } else if (!accountChecked && account.loading && !account.user) {
    controls = <p role="status">ログイン状態を確認しています…</p>;
  } else if (!account.user) {
    controls = (
      <>
        <p>{submitLabel}にはログインしてください。</p>
        <AppButton onPress={signIn}>ログインして{reply ? "返信" : "投稿"}</AppButton>
      </>
    );
  } else if (account.user.isGuest) {
    controls = (
      <>
        <p>掲示板への投稿にはアカウント登録が必要です。</p>
        <AppButton onPress={signIn}>アカウント登録へ</AppButton>
      </>
    );
  } else if (!account.user.profileCompleted) {
    controls = (
      <>
        <p>プロフィールの初回設定を完了すると投稿できます。</p>
        <AppButtonLink to="/account/setup">プロフィールを設定する</AppButtonLink>
      </>
    );
  } else {
    controls = (
      <form className="grid gap-3" onSubmit={submit}>
        <textarea
          rows={3}
          className="w-full min-w-0 resize-y rounded-control border border-solid border-line bg-white p-3 text-base text-ink wrap-anywhere focus-visible:outline-[3px] focus-visible:outline-focus"
          aria-label={placeholder}
          aria-describedby={description}
          placeholder={placeholder}
          value={text}
          readOnly={pending}
          onChange={(event) => {
            requestId.current = null;
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
        {error && (
          <p role="alert" className="text-danger">
            {error}
          </p>
        )}
        <div className="flex flex-wrap items-center justify-end gap-3">
          <span id={description} className={count > textLimit ? "text-danger" : "text-muted"}>
            {count}/{textLimit}
          </span>
          <AppButton
            type="submit"
            isPending={pending}
            isDisabled={busy || !text.trim() || count > textLimit}
          >
            {submitLabel}
          </AppButton>
        </div>
      </form>
    );
  }

  return <AppCard className="min-w-0 gap-3 text-sm">{controls}</AppCard>;
}
