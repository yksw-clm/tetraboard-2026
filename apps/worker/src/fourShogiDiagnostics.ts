export function logFourShogiDiagnostic(
  bindings: { FOUR_SHOGI_DIAGNOSTICS?: string },
  event: string,
  fields: Record<string, string | number | boolean>,
) {
  if (bindings.FOUR_SHOGI_DIAGNOSTICS === "true")
    console.info({ event, game: "four-shogi", ...fields });
}
