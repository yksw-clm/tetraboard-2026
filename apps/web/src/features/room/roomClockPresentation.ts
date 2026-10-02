export function formatClock(milliseconds: number): string {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export function clockPresentation({
  timeControl,
  remainingMainMs = timeControl.mainTimeMs,
  turnStartedAt = 0,
  turnExpiresAt = 0,
  isTurn = false,
  serverNowMs,
}: {
  timeControl: { mainTimeMs: number; byoyomiMs: number };
  remainingMainMs?: number;
  turnStartedAt?: number;
  turnExpiresAt?: number;
  isTurn?: boolean;
  serverNowMs: number;
}) {
  const remainingMain = Math.max(
    0,
    remainingMainMs - (isTurn ? Math.max(0, serverNowMs - turnStartedAt) : 0),
  );
  const byoyomi = remainingMain === 0;
  const remaining = byoyomi
    ? isTurn
      ? Math.max(0, turnExpiresAt - serverNowMs)
      : timeControl.byoyomiMs
    : remainingMain;
  return {
    text: formatClock(remaining),
    byoyomi,
    urgent: byoyomi && Math.ceil(remaining / 1000) < 10,
  };
}
