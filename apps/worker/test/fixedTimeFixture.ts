import { onTestFinished, vi } from "vitest";

// Dateだけを固定し、WebSocketや非同期処理を待つ実タイマーは動かします。
export function fixTestTime(at = Date.now()) {
  const clock = vi.spyOn(Date, "now").mockReturnValue(at);
  onTestFinished(() => clock.mockRestore());
  return clock;
}
