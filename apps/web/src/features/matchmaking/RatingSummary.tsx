import { useEffect, useState } from "react";
import { ratedMatchmakingRules, type RatedMatchmakingGame } from "@tetraboard/protocol";
import { AppButton } from "../../shared/ui/AppButton";
import { readRatingSummary } from "./matchmakingApi";

export function RatingSummary({
  game,
  compact = false,
}: {
  game: RatedMatchmakingGame;
  compact?: boolean;
}) {
  const { placementGames } = ratedMatchmakingRules[game];
  const [result, setResult] = useState<
    Awaited<ReturnType<typeof readRatingSummary>> | "error" | null
  >(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void readRatingSummary(game, controller.signal).then(
      (summary) => {
        if (!controller.signal.aborted) setResult(summary);
      },
      () => {
        if (!controller.signal.aborted) setResult("error");
      },
    );
    return () => controller.abort();
  }, [attempt, game]);

  if (result === null) return <p role="status">レートを読み込んでいます…</p>;
  if (result === "error")
    return (
      <div className={`flex flex-col gap-2 ${compact ? "items-start" : "items-center"}`}>
        <p role="alert">レートを取得できませんでした。</p>
        <AppButton
          appearance="secondary"
          size="compact"
          onPress={() => {
            setResult(null);
            setAttempt((current) => current + 1);
          }}
        >
          レートを再取得する
        </AppButton>
      </div>
    );
  if (compact)
    return (
      <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-sm text-muted">レート戦のレート</span>
        <strong className="text-xl font-bold tabular-nums">
          {result.status === "rated"
            ? Math.round(result.rating)
            : `認定中（${result.games} / ${placementGames}局）`}
        </strong>
      </p>
    );
  return (
    <div className="text-center">
      <p className="text-sm text-muted">現在のレート</p>
      <p className="mt-1 text-4xl font-bold tabular-nums">
        {result.status === "rated" ? Math.round(result.rating) : "認定中"}
      </p>
      {result.status === "placement" && (
        <p className="mt-1 text-sm tabular-nums">
          {result.games} / {placementGames}局
        </p>
      )}
    </div>
  );
}
