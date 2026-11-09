import type { ReactNode } from "react";

export function RoomStartCountdown({
  startsAtMs,
  serverNowMs,
  durationMs,
  label,
  details,
}: {
  startsAtMs: number;
  serverNowMs: number;
  durationMs: number;
  label: string;
  details?: ReactNode;
}) {
  const seconds = Math.max(
    0,
    Math.min(Math.ceil(durationMs / 1000), Math.ceil((startsAtMs - serverNowMs) / 1000)),
  );
  return (
    <div
      role="status"
      aria-label={label}
      className="absolute inset-0 z-40 grid place-items-center bg-black/70 text-white"
    >
      <div className="space-y-4 px-5 text-center">
        <p className="text-xl font-bold">
          {seconds > 0 ? "まもなく対局が始まります" : "対局を開始しています…"}
        </p>
        {details}
        {seconds > 0 && (
          <strong className="block text-[96px] leading-none font-bold tabular-nums">
            {seconds}
          </strong>
        )}
      </div>
    </div>
  );
}
