import { cn } from "@heroui/react";
import type { Color } from "@tetraboard/four-reversi";

const colors = {
  black: "stone-black",
  white: "stone-white",
  red: "stone-red",
  blue: "stone-blue",
} satisfies Record<Color, string>;

export function Stone({
  color,
  className,
  square,
}: {
  color: Color;
  className?: string;
  square?: string;
}) {
  return (
    <span
      aria-hidden="true"
      data-board-piece={square}
      className={cn(
        "stone block rounded-full border border-solid border-[#0003]",
        colors[color],
        className,
      )}
    />
  );
}
