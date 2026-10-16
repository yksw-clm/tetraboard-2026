import { useCallback, useEffect, useState } from "react";
import type { TournamentPublic } from "@tetraboard/protocol";
import { AppCard } from "../../shared/ui/AppCard";
import { AppButton, AppButtonLink } from "../../shared/ui/AppButton";
import { AppIcon } from "../../shared/ui/AppIcon";
import { useAccount } from "../account/useAccount";
import { readLobbyTournament, readTournamentParticipation } from "./tournamentApi";
import { TournamentStatus } from "./TournamentStatus";
import { tournamentDate, tournamentRemaining } from "./tournamentPresentation";
import { TournamentConsent } from "./TournamentConsent";
export function TournamentEntrance() {
  const account = useAccount();
  const identity = account.user?.profileCompleted ? account.user.username : null;
  const [state, setState] = useState<{
    tournament: TournamentPublic | null;
    entered: boolean;
    identity: string | null;
    error: string | null;
  }>({ tournament: null, entered: false, identity, error: null });
  const [revision, setRevision] = useState(0);
  const retry = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    let controller: AbortController | null = null;
    let disposed = false;
    async function load() {
      if (controller) return;
      controller = new AbortController();
      try {
        const { tournament } = await readLobbyTournament(controller.signal);
        const participation =
          tournament && identity
            ? await readTournamentParticipation(tournament.id, controller.signal)
            : null;
        if (!disposed)
          setState({ tournament, entered: participation?.entered ?? false, identity, error: null });
      } catch {
        if (!disposed)
          setState((previous) => ({ ...previous, error: "大会の情報を取得できませんでした。" }));
      } finally {
        controller = null;
      }
    }
    const timeout = window.setTimeout(() => void load(), 0);
    const refresh = () => {
      if (document.visibilityState === "visible") void load();
    };
    const interval = window.setInterval(refresh, 5000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      disposed = true;
      controller?.abort();
      window.clearTimeout(timeout);
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [identity, revision]);
  const tournament = state.tournament;
  if (!tournament)
    return state.error ? (
      <p role="alert" className="text-xs text-danger">
        {state.error}
        <AppButton appearance="quiet" size="compact" onPress={retry}>
          再試行
        </AppButton>
      </p>
    ) : null;
  const ended = tournament.status === "settling" || tournament.status === "finished";
  const entered = state.identity === identity && state.entered;
  return (
    <section aria-label="四人将棋大会" className="space-y-2">
      {!ended && !entered && <TournamentConsent />}
      <AppCard
        density="compact"
        className="flex flex-row flex-wrap items-center justify-between gap-x-5 gap-y-3"
      >
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span className="hidden size-10 shrink-0 place-items-center rounded-control bg-surface-muted text-brand sm:grid">
            <AppIcon name="crown" />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h2 className="text-sm font-bold">{tournament.name}</h2>
              <TournamentStatus stage={tournament.status} />
            </div>
            <p className="text-xs text-muted">
              {tournament.status === "finished"
                ? "大会の結果を公開しています。"
                : tournament.status === "settling"
                  ? "対局と結果の保存を待っています。順位は暫定です。"
                  : `${tournament.status === "active" ? tournamentRemaining(tournament) : tournamentDate(tournament.startsAtMs, tournament.endsAtMs)} · 現在${tournament.entryCount}人がエントリー中`}
            </p>
            {state.error && (
              <p role="alert" className="text-xs text-danger">
                {state.error}
                <AppButton appearance="quiet" size="compact" onPress={retry}>
                  再試行
                </AppButton>
              </p>
            )}
          </div>
        </div>
        <div className="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto">
          <AppButtonLink to={`/tournaments/${tournament.id}`} size="compact" className="min-h-11">
            {tournament.status === "finished" ? "結果を見る" : "詳細へ"}
          </AppButtonLink>
          {!ended &&
            (entered && tournament.status === "upcoming" ? (
              <AppButton isDisabled appearance="secondary" size="compact">
                エントリー済み
              </AppButton>
            ) : (
              <AppButtonLink
                to={`/tournaments/${tournament.id}`}
                state={entered ? undefined : { tournamentEntryRequested: true }}
                size="compact"
                className="min-h-11 whitespace-normal text-center"
              >
                {entered
                  ? "大会に参加"
                  : !account.user
                    ? "ログインまたは登録してエントリー"
                    : "エントリー"}
              </AppButtonLink>
            ))}
        </div>
      </AppCard>
    </section>
  );
}
