export function TournamentRoomCountdown({
  startsAtMs,
  serverNowMs,
}: {
  startsAtMs: number;
  serverNowMs: number;
}) {
  const seconds = Math.max(0, Math.ceil((startsAtMs - serverNowMs) / 1000));
  return (
    <div
      role="status"
      aria-label="大会対局の開始カウントダウン"
      className="absolute inset-0 z-40 grid place-items-center bg-black/70 text-white"
    >
      <div className="space-y-4 px-5 text-center">
        <p className="text-xl font-bold">
          {seconds > 0 ? "まもなく対局が始まります" : "対局を開始しています…"}
        </p>
        {seconds > 0 && (
          <strong className="block text-[96px] leading-none font-bold tabular-nums">
            {seconds}
          </strong>
        )}
      </div>
    </div>
  );
}
