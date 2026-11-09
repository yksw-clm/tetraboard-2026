import { AppButton } from "../../shared/ui/AppButton";
import type { useShogiRatingResult } from "./useShogiRatingResult";

export function ShogiRatingResult({
  result,
  failed,
  retry,
}: ReturnType<typeof useShogiRatingResult>) {
  if (!failed && result?.status === "placement") return null;
  if (!failed && result?.status === "rated") {
    if (!result.placementCompleted && result.humanPlayed) return null;
    return (
      <p role="status" className="mt-3 text-sm text-muted">
        {[result.placementCompleted && "認定完了", !result.humanPlayed && "対人戦未経験"]
          .filter(Boolean)
          .join("・")}
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
