import type { GameId } from "@tetraboard/protocol/games";
import { gameCatalog } from "@tetraboard/protocol/games";
import type { PlayerProfile, RoomMode } from "@tetraboard/protocol";
import { PlayerAvatar } from "../room/PlayerAvatar";
import { formatStatsRate } from "../account/statsPresentation";
import { AppButton } from "../../shared/ui/AppButton";
import type { ProfileState } from "./playerProfileStore";
import { PlayerBadges } from "../badges/PlayerBadges";
export function PlayerProfileCard({
  state,
  localProfile,
  game,
  mode,
  onRetry,
}: {
  state: ProfileState;
  localProfile?: PlayerProfile;
  game: GameId;
  mode: RoomMode;
  onRetry: () => void;
}) {
  const profile = localProfile ?? state.profile;
  if (!profile || state.loading)
    return (
      <div className="flex flex-col items-start gap-2 pr-8" role="status">
        <p className="m-0 text-sm">
          {state.loading
            ? "プレイヤー情報を読み込んでいます…"
            : (state.error ?? "プレイヤー情報は準備中です。")}
        </p>
        {state.error && (
          <AppButton
            size="compact"
            appearance="secondary"
            isPending={state.loading}
            onPress={onRetry}
          >
            再試行
          </AppButton>
        )}
      </div>
    );
  const name = profile.kind === "cpu" ? `CPU Lv${profile.level}` : profile.name;
  const stats = profile.kind === "account" ? profile.stats[mode] : null;
  const wins =
    profile.kind === "account"
      ? mode === "singles"
        ? profile.stats.singles.first
        : profile.stats.doubles.wins
      : 0;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex min-w-0 items-center gap-3 pr-8">
        <PlayerAvatar
          appearance={
            profile.kind === "cpu" ? profile : { kind: "human", avatarUrl: profile.avatarUrl }
          }
          className="size-12"
        />
        <div className="min-w-0">
          <p className="m-0 font-bold wrap-anywhere">{name}</p>
          {profile.kind === "account" && (
            <p className="m-0 text-sm text-muted wrap-anywhere">@{profile.username}</p>
          )}
        </div>
      </div>
      {profile.kind === "account" && stats ? (
        <>
          <div>
            <p className="m-0 text-xs font-semibold">
              {gameCatalog[game].name}・{mode === "singles" ? "シングルス" : "ダブルス"}
            </p>
            <p className="m-0 text-xs text-muted">対人戦のみ集計</p>
          </div>
          <dl className="m-0 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-sm">
            <dt>対局数</dt>
            <dd className="m-0 tabular-nums">{stats.total}局</dd>
            <dt>{mode === "singles" ? "優勝数" : "勝数"}</dt>
            <dd className="m-0 tabular-nums">{wins}回</dd>
            <dt>{mode === "singles" ? "優勝率" : "勝率"}</dt>
            <dd className="m-0 tabular-nums">{formatStatsRate(wins, stats.total)}</dd>
          </dl>
          {mode === "singles" && <PlayerBadges game={game} badges={profile.badges} />}
        </>
      ) : (
        <p className="m-0 text-sm text-muted">
          {profile.kind === "guest" ? "ゲスト／ID・戦績なし" : "戦績集計対象外"}
        </p>
      )}
    </div>
  );
}
