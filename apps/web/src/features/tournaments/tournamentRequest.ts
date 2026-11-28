export function parseTournamentData<T>(schema: { parse: (body: unknown) => T }, body: unknown): T {
  try {
    return schema.parse(body);
  } catch {
    throw new Error("大会情報の応答を確認できません。もう一度お試しください。");
  }
}

export function requestSignal(signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(10_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
