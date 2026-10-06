import { gameCatalog } from "@tetraboard/protocol/games";
import { type MatchSummary, type MatchHistoryParticipant } from "@tetraboard/protocol";
import { useLocation, useNavigation } from "react-router";
import { Avatar } from "@heroui/react";
import { AppAvatar } from "../../shared/ui/AppAvatar";
import { AppButtonLink } from "../../shared/ui/AppButton";
import { AppIcon } from "../../shared/ui/AppIcon";
import { matchResultGroups } from "../account/matchSummaryPresentation";
import { formatMatchDate } from "./matchDatePresentation";
function Participant({ player }: { player: MatchHistoryParticipant }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      {player.kind === "cpu" ? (
        <Avatar
          className="size-6 shrink-0 rounded-full bg-[#e0edff] text-[#376597]"
          aria-label="CPUアイコン"
        >
          <Avatar.Fallback className="grid size-full place-items-center bg-transparent text-inherit">
            <AppIcon name="robot" className="size-4" />
          </Avatar.Fallback>
        </Avatar>
      ) : (
        <AppAvatar
          src={player.avatarUrl}
          label={`${player.name}のアイコン`}
          className="size-6 [&_svg]:size-4"
        />
      )}
      <span className="min-w-0 text-xs font-semibold leading-4 [overflow-wrap:anywhere]">
        {player.name}
      </span>
    </div>
  );
}
export function MatchHistoryCard({
  match,
  to,
  className = "",
  relativeToMs,
}: {
  match: MatchSummary;
  to: string;
  className?: string;
  relativeToMs?: number;
}) {
  const navigation = useNavigation();
  const location = useLocation();
  const loading = navigation.state === "loading" && navigation.location?.pathname === to;
  const result = match.result;
  const gameLabel = `${gameCatalog[match.game].name}・${match.mode === "singles" ? "シングルス" : "ダブルス"}`;
  const groups = matchResultGroups(match);
  const absoluteDate = formatMatchDate(match.startedAtMs);
  return (
    <article
      aria-label={`${absoluteDate} ${gameLabel}の対局`}
      className={`flex min-w-0 flex-col gap-3 rounded-control border border-solid border-line bg-white p-3 ${className}`}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
        <time dateTime={new Date(match.startedAtMs).toISOString()} title={absoluteDate}>
          {formatMatchDate(match.startedAtMs, relativeToMs)}
        </time>
        <span>{gameLabel}</span>
      </div>
      {result.mode === "singles" ? (
        <ol className="m-0 grid list-none grid-cols-2 gap-x-3 gap-y-2 p-0">
          {groups.map((group) => {
            const player = group.players[0]!;
            return (
              <li key={player.id} className="flex min-w-0 items-center gap-1.5">
                <span
                  className={`w-7 shrink-0 text-xs font-bold ${group.emphasized ? "text-brand" : "text-muted"}`}
                >
                  {group.label}
                </span>
                <Participant player={player} />
              </li>
            );
          })}
        </ol>
      ) : (
        <div className="flex flex-col gap-2">
          {groups.map((group) => (
            <div
              key={group.players[0]!.id}
              className="grid grid-cols-[48px_minmax(0,1fr)_minmax(0,1fr)] items-center gap-1.5"
            >
              <span
                className={`text-xs font-bold ${group.emphasized ? "text-brand" : "text-muted"}`}
              >
                {group.label}
              </span>
              {group.players.map((player) => (
                <Participant key={player.id} player={player} />
              ))}
            </div>
          ))}
        </div>
      )}
      <div className="mt-auto flex flex-wrap items-center justify-end gap-2">
        {loading && (
          <span className="text-xs text-muted" role="status">
            棋譜を読み込んでいます…
          </span>
        )}
        <AppButtonLink size="compact" appearance="secondary" to={to} state={location.state}>
          棋譜を見る
        </AppButtonLink>
      </div>
    </article>
  );
}
