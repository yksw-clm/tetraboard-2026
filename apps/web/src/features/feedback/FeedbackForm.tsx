import { gameCatalog, gameIds, isGameScope } from "@tetraboard/protocol/games";
import { Link } from "react-router";
import { countCharacters } from "@tetraboard/protocol";
import { AppButton } from "../../shared/ui/AppButton";
import type { useFeedback, FeedbackContext } from "./useFeedback";
const fieldClass =
  "w-full rounded-control border border-line bg-white p-3 text-sm text-ink focus-visible:outline-focus disabled:opacity-60";
export function FeedbackForm({
  feedback,
  context,
}: {
  feedback: ReturnType<typeof useFeedback>;
  context: FeedbackContext;
}) {
  const { draft, busy, technicalInfo } = feedback;
  if (feedback.receipt)
    return (
      <div className="space-y-4">
        <div role="status">
          <h2 className="text-lg font-bold">ご意見を受け付けました</h2>
          <p className="mt-2">ありがとうございます。サービスの改善に役立てます。</p>
        </div>
        <p className="break-all text-sm">受付番号：{feedback.receipt}</p>
        <p className="text-sm text-muted">
          個別の返信はありません。公開した改善はお知らせでお伝えします。
        </p>
        <Link to="/updates" className="text-brand underline">
          改善のお知らせを見る
        </Link>
        <div>
          <AppButton appearance="secondary" onPress={feedback.reset}>
            別のご意見を送る
          </AppButton>
        </div>
      </div>
    );
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        void feedback.submit();
      }}
    >
      <p className="text-sm text-muted">不具合や、もっと楽しむためのアイデアをお聞かせください。</p>
      <label className="block text-sm font-bold">
        種別（必須）
        <select
          className={`${fieldClass} mt-1`}
          value={draft.kind}
          disabled={busy}
          onChange={(e) => feedback.update("kind", e.target.value as typeof draft.kind)}
        >
          <option value="">選んでください</option>
          <option value="bug">不具合</option>
          <option value="request">機能の要望</option>
          <option value="opinion">その他のご意見</option>
        </select>
      </label>
      <label className="block text-sm font-bold">
        対象
        <select
          className={`${fieldClass} mt-1`}
          value={draft.game}
          disabled={busy}
          onChange={(e) => {
            if (isGameScope(e.target.value)) feedback.update("game", e.target.value);
          }}
        >
          <option value="all">サービス全体</option>
          {gameIds.map((id) => (
            <option key={id} value={id}>
              {gameCatalog[id].name}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-sm font-bold">
        内容（必須）
        <textarea
          className={`${fieldClass} mt-1 min-h-28`}
          rows={4}
          value={draft.body}
          disabled={busy}
          onChange={(e) => feedback.update("body", e.target.value)}
          placeholder={
            draft.kind === "request"
              ? "欲しい機能や、今困っていることを教えてください。"
              : "起きたことや、感じたことを教えてください。"
          }
        />
        <span className="block text-right text-xs font-normal text-muted">
          {countCharacters(draft.body.trim())}/2,000文字
        </span>
      </label>
      <label className="block text-sm font-bold">
        {draft.kind === "bug"
          ? "期待していた動作"
          : draft.kind === "request"
            ? "何ができると嬉しいですか？"
            : "期待・目的"}
        （任意）
        <textarea
          className={`${fieldClass} mt-1`}
          rows={2}
          value={draft.expectation}
          disabled={busy}
          onChange={(e) => feedback.update("expectation", e.target.value)}
        />
        <span className="block text-right text-xs font-normal text-muted">
          {countCharacters(draft.expectation.trim())}/500文字
        </span>
      </label>
      {draft.kind === "bug" && (
        <>
          <label className="block text-sm font-bold">
            再現手順（任意）
            <textarea
              className={`${fieldClass} mt-1`}
              rows={3}
              value={draft.steps}
              disabled={busy}
              onChange={(e) => feedback.update("steps", e.target.value)}
              placeholder="どの操作をすると起きますか？"
            />
            <span className="block text-right text-xs font-normal text-muted">
              {countCharacters(draft.steps.trim())}/1,000文字
            </span>
          </label>
          <div className="rounded-control bg-surface-muted p-3 text-xs">
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft.technical}
                disabled={busy}
                onChange={(e) => feedback.update("technical", e.target.checked)}
              />
              技術情報を添付する
            </label>
            <details>
              <summary className="cursor-pointer py-2">送る技術情報を確認</summary>
              <div className="break-words space-y-1">
                <p>
                  画面：{technicalInfo.page} ／ 対象：{technicalInfo.game}
                </p>
                <p>ブラウザ：{technicalInfo.browser}</p>
                <p>
                  画面サイズ：{technicalInfo.width}×{technicalInfo.height}
                </p>
                <p>ビルド：{technicalInfo.build}</p>
                {technicalInfo.room && (
                  <p>
                    部屋：{technicalInfo.room.id} ／ 世代：{technicalInfo.room.instanceId} ／ 局：
                    {technicalInfo.room.roundId ?? "—"}
                  </p>
                )}
                <p>URL・招待情報・参加資格・チャット・盤面は送信しません。</p>
              </div>
            </details>
          </div>
        </>
      )}
      <label className="block text-sm font-bold">
        スクリーンショット（任意・1枚）
        <input
          className={`${fieldClass} mt-1 file:mr-2 file:rounded file:border-0 file:px-2 file:py-1`}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          disabled={busy}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void feedback.selectImage(file);
          }}
        />
      </label>
      {feedback.preview && (
        <div className="space-y-2">
          <img
            src={feedback.preview}
            alt="添付するスクリーンショットのプレビュー"
            className="max-h-64 w-full object-contain rounded-control"
          />
          <AppButton
            appearance="quiet"
            size="compact"
            isDisabled={busy}
            onPress={feedback.removeImage}
          >
            画像を取り消す
          </AppButton>
        </div>
      )}
      <p className="text-xs text-muted">
        元画像は5MBまで。名前やチャットが写る場合は、隠してから添付してください。
      </p>
      <p className="text-xs text-muted">
        投稿は公開されません。個別の返信はありません。保存期間は180日です。改善内容は
        <Link to="/updates" className="text-brand underline">
          お知らせ
        </Link>
        で確認できます。
      </p>
      {context.page === "room" && (
        <p className="text-xs text-muted">入力中も対局と時計は進みます。</p>
      )}
      {feedback.message && (
        <p role="alert" className="text-sm text-danger">
          {feedback.message}
        </p>
      )}
      <AppButton className="w-full" type="submit" isDisabled={busy}>
        {busy ? "処理中…" : "送信する"}
      </AppButton>
    </form>
  );
}
