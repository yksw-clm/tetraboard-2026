import { type Room } from "@tetraboard/protocol";
import { type Color } from "@tetraboard/four-reversi";

export const colorNames: Record<Color, string> = {
  black: "黒",
  white: "白",
  red: "赤",
  blue: "青",
};

function formatClock(milliseconds: number): string {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export function playerClockText(room: Room, color: Color, serverNowMs: number): string | null {
  if (room.status !== "playing" || room.game.eliminatedColors.includes(color)) return null;
  const main = room.clock.remainingMainMs[color];
  if (room.game.turn !== color) {
    return main > 0
      ? `残り ${formatClock(main)}`
      : `秒読み ${formatClock(room.settings.timeControl.byoyomiMs)}/手`;
  }
  const remainingMain = Math.max(0, main - Math.max(0, serverNowMs - room.clock.turnStartedAt));
  return remainingMain > 0
    ? `残り ${formatClock(remainingMain)}`
    : `秒読み ${formatClock(room.clock.turnExpiresAt - serverNowMs)}`;
}
