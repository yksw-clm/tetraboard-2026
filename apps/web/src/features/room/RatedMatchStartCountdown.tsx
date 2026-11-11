import { useEffect, useSyncExternalStore, type CSSProperties } from "react";
import type { PlayerProfileTarget, Room } from "@tetraboard/protocol";
import { isRatedMatchmakingGame, matchmakingQueues } from "@tetraboard/protocol";
import { gameCatalog } from "@tetraboard/protocol/games";
import { AppIcon } from "../../shared/ui/AppIcon";
import { usePlayerProfiles } from "../players/usePlayerProfiles";
import { emptyProfileState, profileKey } from "../players/playerProfileStore";
import { PlayerAvatar } from "./PlayerAvatar";
import { playerAppearance, playerName } from "./roomCommonPresentation";
import "./ratedMatchStartCountdown.css";

const idleSubscribe = () => () => {};
const roomTarget = (room: Room, playerId: string): PlayerProfileTarget => ({
  source: "room",
  roomId: room.id,
  instanceId: room.instanceId,
  playerId,
});

export function RatedMatchStartCountdown({
  room,
  ownPlayerId,
  startsAtMs,
  serverNowMs,
}: {
  room: Room;
  ownPlayerId?: string;
  startsAtMs?: number;
  serverNowMs: number;
}) {
  const store = usePlayerProfiles()?.store;
  const game = room.settings.game;
  useEffect(() => {
    if (!isRatedMatchmakingGame(game)) return;
    for (const player of room.players) {
      if (player.kind === "human" && player.retired) continue;
      void store?.load(
        { source: "room", roomId: room.id, instanceId: room.instanceId, playerId: player.id },
        game,
      );
    }
  }, [store, game, room.id, room.instanceId, room.players]);

  if (startsAtMs === undefined || !isRatedMatchmakingGame(game)) return null;
  const queue = matchmakingQueues[game];
  const seconds = Math.max(
    0,
    Math.min(Math.ceil(queue.countdownMs / 1000), Math.ceil((startsAtMs - serverNowMs) / 1000)),
  );
  const self = room.players.find((player) => player.id === ownPlayerId);
  const opponents = room.players.filter((player) => player.id !== self?.id);
  const time = queue.timeControl;
  return (
    <section
      aria-label="対局の開始カウントダウン"
      className="rated-match-intro absolute inset-0 z-40 overflow-x-hidden overflow-y-auto text-ink"
    >
      <div className="rated-match-intro-content mx-auto flex min-h-full w-full max-w-[880px] flex-col justify-center py-5 sm:py-8">
        <header className="mb-5 flex items-start justify-between gap-3 px-5 sm:mb-7 sm:px-8">
          <div>
            <p className="mb-2 flex items-center gap-1.5 text-xs font-bold text-brand">
              <AppIcon name="trophy" className="size-4" />
              レート戦
            </p>
            <h1 className="text-xl font-bold sm:text-2xl">{gameCatalog[game].name}</h1>
          </div>
          <p className="text-right text-xs leading-relaxed text-muted">
            シングルス
            <br />
            {time.mainTimeMs / 60_000}分
            {time.byoyomiMs ? `＋${time.byoyomiMs / 1000}秒` : "切れ負け"}
          </p>
        </header>
        <div className="rated-match-intro-arena">
          <ul
            aria-label={self ? "対戦相手" : "対戦者"}
            className="rated-match-intro-opponents m-0 flex list-none flex-col gap-2.5 p-0 sm:gap-3"
          >
            {opponents.map((player, index) => (
              <li key={player.id} style={{ "--intro-delay": `${index * 80}ms` } as CSSProperties}>
                <IntroPlayer room={room} player={player} />
              </li>
            ))}
          </ul>
          <div className="rated-match-intro-clock flex items-center justify-center gap-3 text-brand sm:flex-col">
            <span aria-hidden="true" className="text-lg font-bold italic sm:text-xl">
              VS
            </span>
            <div
              className="rated-match-intro-ring grid shrink-0 place-items-center"
              style={{ "--intro-progress": seconds / (queue.countdownMs / 1000) } as CSSProperties}
              role="status"
              aria-label={seconds > 0 ? `開始まで${seconds}秒` : "対局を開始しています"}
            >
              <strong
                key={seconds}
                className={`rated-match-intro-seconds relative font-bold tabular-nums ${seconds > 0 ? "text-4xl sm:text-6xl" : "text-lg"}`}
              >
                {seconds > 0 ? seconds : "開始"}
              </strong>
            </div>
            <span className="text-xs text-muted">
              {seconds > 0 ? "開始まで" : "開始しています…"}
            </span>
          </div>
          {self && (
            <div className="rated-match-intro-self">
              <IntroPlayer room={room} player={self} own />
            </div>
          )}
        </div>
        <p className="mt-5 flex items-center gap-1.5 px-5 text-xs text-muted sm:mt-7 sm:px-8">
          <AppIcon name="check" className="size-4 text-brand" />
          まもなく対局が始まります
        </p>
      </div>
    </section>
  );
}

function IntroPlayer({
  room,
  player,
  own = false,
}: {
  room: Room;
  player: Room["players"][number];
  own?: boolean;
}) {
  const store = usePlayerProfiles()?.store;
  const key = profileKey(roomTarget(room, player.id), room.settings.game);
  const state = useSyncExternalStore(
    store?.subscribe ?? idleSubscribe,
    () => store?.get(key) ?? emptyProfileState,
    () => emptyProfileState,
  );
  const retired = player.kind === "human" && player.retired;
  const profile = retired ? null : state.profile;
  const account = profile?.kind === "account" ? profile : undefined;
  const rating = profile && "rating" in profile ? profile.rating : undefined;
  const unavailable = retired ? "—" : state.error ? "取得失敗" : profile ? "—" : "取得中";
  const beforeRating =
    rating?.timing === "before" || rating?.timing === "reference" ? rating : undefined;
  const rate =
    beforeRating?.status === "rated"
      ? String(Math.round(beforeRating.rating))
      : beforeRating?.status === "placement"
        ? "認定中"
        : unavailable;
  const stats = account?.stats;
  const record = stats
    ? "wins" in stats
      ? `${stats.total}戦 ${stats.wins}勝`
      : `${stats.singles.total}戦 ${stats.singles.first}優勝`
    : player.kind === "cpu" || profile?.kind === "guest"
      ? "—"
      : unavailable;
  const name = retired ? "退会したプレイヤー" : playerName(player);
  return (
    <article
      className="rated-match-intro-player"
      data-self={own}
      aria-label={`${name}の対局前情報`}
    >
      <p className="mb-2 flex items-center gap-2 text-xs font-bold text-brand">
        {own ? "あなた" : "対戦相手"}
        {player.kind === "cpu" && <span className="font-normal text-muted">CPU</span>}
      </p>
      <div className="rated-match-intro-player-grid">
        <PlayerAvatar
          appearance={retired ? { kind: "human", avatarUrl: null } : playerAppearance(player)}
          className="rated-match-intro-avatar size-9 sm:size-11"
        />
        <h2
          className="rated-match-intro-name text-base font-bold wrap-anywhere sm:text-lg"
          title={name}
        >
          {name}
        </h2>
        <p className="rated-match-intro-id text-xs text-muted wrap-anywhere">
          ID:{" "}
          {account?.username
            ? `@${account.username}`
            : player.kind === "cpu" || profile?.kind === "guest"
              ? "—"
              : unavailable}
        </p>
        <div className="rated-match-intro-rating flex min-w-0 flex-col items-end gap-1 text-right">
          <span className="text-xs text-muted">
            {player.kind === "cpu" ? "基準レート" : "対局前レート"}
          </span>
          <strong
            className={`font-bold tabular-nums ${beforeRating?.status === "rated" ? "text-2xl sm:text-3xl" : "text-sm sm:text-base"}`}
          >
            {rate}
          </strong>
        </div>
        <p className="rated-match-intro-record flex flex-wrap gap-x-2 text-xs tabular-nums">
          <span className="text-muted">通算成績</span>
          <span>{record}</span>
        </p>
      </div>
    </article>
  );
}
