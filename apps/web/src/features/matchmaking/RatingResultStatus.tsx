import { AppButton } from "../../shared/ui/AppButton";
import type { useRatingResult } from "./useRatingResult";

export function RatingResultStatus({ result, failed, retry }: ReturnType<typeof useRatingResult>) {
  if (!failed && result?.status === "placement") return null;
  if (!failed && result?.status === "rated") {
    if (!result.placementCompleted) return null;
    return (
      <p role="status" className="mt-3 text-sm text-muted">
        認定完了
      </p>
    );
  }
  return (
    <div role="status" className="mt-3 space-y-1 rounded-lg bg-surface-muted p-3 text-sm">
      {failed ? (
        <>
          <p>レート結果を取得できませんでした。</p>
          <AppButton size="compact" appearance="secondary" onPress={retry}>
            再試行
          </AppButton>
        </>
      ) : !result || result.status === "pending" ? (
        <p>レート結果を保存しています…</p>
      ) : result.status === "excluded" ? (
        <p>
          {result.reason === "ai_fallback"
            ? "AIの代替手を使ったため、この対局はレートと認定局数に反映されません。"
            : "この対局はレートと認定局数に反映されませんでした。"}
        </p>
      ) : null}
    </div>
  );
}
