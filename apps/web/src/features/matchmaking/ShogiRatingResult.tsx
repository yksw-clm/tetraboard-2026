import { shogiPlacementGames } from "@tetraboard/protocol";
import { AppButton } from "../../shared/ui/AppButton";
import type { useShogiRatingResult } from "./useShogiRatingResult";

export function ShogiRatingResult({
  result,
  failed,
  retry,
}: ReturnType<typeof useShogiRatingResult>) {
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
      ) : result.status === "placement" ? (
        <p className="font-semibold">
          認定戦 {result.games} / {shogiPlacementGames}局
        </p>
      ) : result.status === "excluded" ? (
        <p>
          {result.reason === "ai_fallback"
            ? "AIの代替手を使ったため、この対局はレートと認定局数に反映されません。"
            : "この対局はレートと認定局数に反映されませんでした。"}
        </p>
      ) : (
        <>
          {result.placementCompleted && <p>認定完了</p>}
          <p className="font-bold tabular-nums">
            レート {Math.round(result.rating)}（
            {new Intl.NumberFormat("ja", { signDisplay: "exceptZero" }).format(
              Math.round(result.rating) - Math.round(result.previousRating),
            )}
            ）
          </p>
          {!result.humanPlayed && <p className="text-xs text-muted">対人戦未経験</p>}
        </>
      )}
    </div>
  );
}
