import type { GomokuRejection } from "@tetraboard/gomoku/definition";
import type { ProgressError } from "../gameProgress";

export function gomokuMoveError(reason: GomokuRejection): ProgressError {
  if (reason.type !== "forbidden") return "invalid_move";
  const code = `gomoku_${["double_three", "double_four", "overline"].filter((pattern) => reason.forbidden.some((value) => value === pattern)).join("_")}`;
  switch (code) {
    case "gomoku_double_three":
    case "gomoku_double_four":
    case "gomoku_overline":
    case "gomoku_double_three_double_four":
    case "gomoku_double_three_overline":
    case "gomoku_double_four_overline":
    case "gomoku_double_three_double_four_overline":
      return code;
    default:
      throw new Error("Unknown forbidden pattern");
  }
}
