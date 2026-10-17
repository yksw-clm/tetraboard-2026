import { useRef, useState } from "react";
import { countCharacters, feedbackInputSchema, type FeedbackInput } from "@tetraboard/protocol";
import { AppDialog } from "../../shared/ui/AppDialog";
import { AppButton } from "../../shared/ui/AppButton";
import { createUuid } from "../../shared/createUuid";
import type { AppTheme } from "../../shared/ui/appTheme";
import type { PostGameFeedbackContext } from "./usePostGameFeedback";
import { sendFeedback } from "./feedbackApi";

export function PostGameFeedbackDialog({
  context,
  theme,
  onClose,
}: {
  context: PostGameFeedbackContext;
  theme: AppTheme;
  onClose: () => void;
}) {
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const pending = useRef(false);
  const frozen = useRef<FeedbackInput | null>(null);
  function changed() {
    frozen.current = null;
    setMessage(null);
  }
  async function submit() {
    if (pending.current) return;
    const parsed = feedbackInputSchema.safeParse(
      frozen.current ?? {
        submissionId: createUuid(),
        accountRequired: context.accountRequired,
        kind: "opinion",
        game: context.game,
        body: comment,
        rating,
        opponent: context.opponent,
      },
    );
    if (!parsed.success) {
      setMessage("星を1〜5で選び、コメントは2,000文字以内で入力してください。");
      return;
    }
    frozen.current = parsed.data;
    pending.current = true;
    setBusy(true);
    setMessage(null);
    try {
      await sendFeedback(parsed.data, null);
      setSent(true);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "送信できませんでした。再試行してください。",
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <AppDialog
      title="遊んでみていかがでしたか？"
      size="compact"
      theme={theme}
      busy={busy}
      onClose={onClose}
    >
      {sent ? (
        <div className="space-y-4">
          <p role="status">ご協力ありがとうございます。サービスの改善に役立てます。</p>
          <AppButton onPress={onClose}>閉じる</AppButton>
        </div>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <p className="text-sm text-muted">よろしければ、今回の対局の感想をお聞かせください。</p>
          <fieldset disabled={busy} className="border-0 p-0 m-0">
            <legend className="text-sm font-bold">評価（必須）</legend>
            <div className="mt-2 flex justify-center gap-1">
              {[1, 2, 3, 4, 5].map((value) => (
                <label
                  key={value}
                  className="relative grid size-12 cursor-pointer place-items-center rounded-control focus-within:outline-[3px] focus-within:outline-focus"
                >
                  <input
                    type="radio"
                    name="rating"
                    value={value}
                    checked={rating === value}
                    aria-label={`${value}つ星`}
                    className="sr-only"
                    onChange={() => {
                      changed();
                      setRating(value);
                    }}
                  />
                  <span
                    aria-hidden="true"
                    className={`text-4xl ${value <= rating ? "text-amber-500" : "text-gray-300"}`}
                  >
                    ★
                  </span>
                </label>
              ))}
            </div>
            <p className="text-center text-sm text-muted" aria-live="polite">
              {rating ? `${rating} / 5` : "星を選んでください"}
            </p>
          </fieldset>
          <label className="block text-sm font-bold">
            コメント（任意）
            <textarea
              rows={3}
              value={comment}
              disabled={busy}
              className="mt-1 w-full rounded-control border border-line bg-white p-3 text-sm text-ink focus-visible:outline-focus"
              onChange={(event) => {
                changed();
                setComment(event.target.value);
              }}
            />
            <span className="text-xs font-normal text-muted">
              {countCharacters(comment.trim())} / 2,000文字
            </span>
          </label>
          <p className="text-xs text-muted">
            評価とコメントは公開されません。個人情報は入力しないでください。
          </p>
          {message && (
            <p role="alert" className="text-sm text-danger">
              {message}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <AppButton appearance="secondary" isDisabled={busy} onPress={onClose}>
              スキップ
            </AppButton>
            <AppButton type="submit" isDisabled={busy || rating === 0} isPending={busy}>
              送信する
            </AppButton>
          </div>
        </form>
      )}
    </AppDialog>
  );
}
