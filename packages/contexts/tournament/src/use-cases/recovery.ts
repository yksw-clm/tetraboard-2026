import type { TournamentRecoveryPorts } from "./ports";
export async function recoverTournaments(ports: TournamentRecoveryPorts) {
  await ports.expireWaiting();
  for (const row of await ports.pending()) await ports.refresh(row.key);
}
