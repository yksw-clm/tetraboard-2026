import { useEffect, useState } from "react";

export function MatchmakingWaitTime({
  joinedAtMs,
  estimatedMatchAtMs,
  serverNowMs,
  receivedAtMs,
}: {
  joinedAtMs: number;
  estimatedMatchAtMs?: number;
  serverNowMs: number;
  receivedAtMs: number;
}) {
  const [now, setNow] = useState(serverNowMs);
  const [deadline, setDeadline] = useState(estimatedMatchAtMs);
  if (estimatedMatchAtMs !== undefined && (deadline === undefined || estimatedMatchAtMs < deadline))
    setDeadline(estimatedMatchAtMs);

  useEffect(() => {
    const update = () =>
      setNow((previous) =>
        Math.max(previous, serverNowMs + Math.max(0, performance.now() - receivedAtMs)),
      );
    update();
    const timer = window.setInterval(update, 1000);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", update);
    };
  }, [serverNowMs, receivedAtMs]);

  const currentNow = Math.max(now, serverNowMs);
  const remaining = deadline === undefined ? 0 : Math.ceil((deadline - currentNow) / 1000);
  const elapsed = Math.max(0, Math.floor((currentNow - joinedAtMs) / 1000));
  const expired = deadline !== undefined && deadline <= currentNow;
  const showEstimate = estimatedMatchAtMs !== undefined && remaining > 0;
  return (
    <div className="flex flex-col gap-1">
      <p role="status">{expired ? "引き続き対戦相手を探しています…" : "対戦相手を探しています…"}</p>
      <p className="text-sm text-muted tabular-nums" aria-live="off">
        {showEstimate ? `マッチングの目安：あと約${remaining}秒` : `待機時間：${elapsed}秒`}
      </p>
    </div>
  );
}
