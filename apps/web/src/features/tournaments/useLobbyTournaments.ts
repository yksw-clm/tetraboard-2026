import { useCallback, useEffect, useState } from "react";
import type { TournamentLobbySections } from "@tetraboard/protocol";
import type { GameId } from "@tetraboard/protocol/games";
import { useAccount } from "../account/useAccount";
import { readLobbyTournaments, readTournamentParticipation } from "./tournamentApi";

type Participation = { entered: boolean; ready: boolean; error: string | null };
const unknownParticipation: Participation = { entered: false, ready: false, error: null };

export function useLobbyTournaments(game: GameId) {
  const account = useAccount();
  const identity = account.user?.profileCompleted
    ? (account.user.profileId ?? account.user.username)
    : null;
  const authAvailable = !account.loading && !account.error;
  const scope = `${game}:${identity ?? "guest"}:${Boolean(authAvailable)}`;
  const [publicState, setPublicState] = useState<{
    game: GameId;
    data: TournamentLobbySections | null;
    error: string | null;
  }>({ game, data: null, error: null });
  const [participations, setParticipations] = useState<{
    scope: string;
    entries: Record<number, Participation>;
  }>({ scope, entries: {} });
  const [revision, setRevision] = useState(0);
  const retry = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    let request: AbortController | null = null;
    let disposed = false;
    async function load() {
      if (disposed || request || document.visibilityState !== "visible") return;
      const controller = new AbortController();
      request = controller;
      try {
        const data = await readLobbyTournaments(game, controller.signal);
        if (disposed || controller.signal.aborted) return;
        // 本人状態を待たずに、大会名・人数・状態を先に表示します。
        setPublicState({ game, data, error: null });
        const eligible = [...data.current, ...data.upcoming].filter(
          (tournament) => tournament.status === "active" || tournament.status === "upcoming",
        );
        if (identity && authAvailable) {
          setParticipations((previous) => ({
            scope,
            entries: Object.fromEntries(
              eligible.map(({ id }) => [
                id,
                previous.scope === scope
                  ? (previous.entries[id] ?? unknownParticipation)
                  : unknownParticipation,
              ]),
            ),
          }));
          await Promise.all(
            eligible.map(async ({ id }) => {
              try {
                const participation = await readTournamentParticipation(id, controller.signal);
                if (disposed || controller.signal.aborted) return;
                setParticipations((previous) => ({
                  scope,
                  entries: {
                    ...previous.entries,
                    [id]: { entered: participation.entered, ready: true, error: null },
                  },
                }));
              } catch {
                if (disposed || controller.signal.aborted) return;
                setParticipations((previous) => ({
                  scope,
                  entries: {
                    ...previous.entries,
                    [id]: {
                      entered: previous.entries[id]?.entered ?? false,
                      ready: previous.entries[id]?.ready ?? false,
                      error: "参加状態を確認できませんでした。",
                    },
                  },
                }));
              }
            }),
          );
        } else setParticipations({ scope, entries: {} });
      } catch {
        if (!disposed && !controller.signal.aborted)
          setPublicState((previous) => ({
            game,
            data: previous.game === game ? previous.data : null,
            error: "大会の情報を取得できませんでした。",
          }));
      } finally {
        if (request === controller) request = null;
      }
    }
    const timeout = window.setTimeout(() => void load(), 0);
    const interval = window.setInterval(() => void load(), 5000);
    const visibility = () => {
      if (document.visibilityState === "visible") void load();
      else {
        request?.abort();
        request = null;
      }
    };
    document.addEventListener("visibilitychange", visibility);
    return () => {
      disposed = true;
      request?.abort();
      window.clearTimeout(timeout);
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [game, identity, authAvailable, scope, revision]);

  const publicData = publicState.game === game ? publicState.data : null;
  return {
    current: publicData?.current ?? [],
    upcoming: publicData?.upcoming ?? [],
    serverTimeMs: publicData?.serverTimeMs ?? 0,
    error: publicState.game === game ? publicState.error : null,
    retry,
    participation: (id: number): Participation =>
      identity
        ? participations.scope === scope
          ? (participations.entries[id] ?? unknownParticipation)
          : unknownParticipation
        : { entered: false, ready: true, error: null },
    authUnavailable: !authAvailable,
  };
}
