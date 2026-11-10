import type { GameId } from "@tetraboard/protocol/games";
import { gameCatalog } from "@tetraboard/protocol/games";
import type { PlayerProfile, RoomMode } from "@tetraboard/protocol";
import { PlayerAvatar } from "../room/PlayerAvatar";
import { formatPlayerStatsSummary } from "./playerStatsSummary";
import { AppButton } from "../../shared/ui/AppButton";
import type { ProfileState } from "./playerProfileStore";
import { PlayerBadges } from "../badges/PlayerBadges";
import { ProfileDetails } from "./ProfileDetails";
import { statsScopeLabel } from "../account/statsPresentation";
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
  const duelRating =
    profile.kind === "account"
      ? game === "reversi"
        ? profile.reversiRating
        : profile.shogiRating
      : undefined;
  const name = profile.kind === "cpu" ? (profile.name ?? `CPU Lv${profile.level}`) : profile.name;
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
            <p className="m-0 text-sm text-muted wrap-anywhere">
              {profile.username && `@${profile.username}`}
              {profile.isGuest && (
                <span className={profile.username ? "ml-2" : undefined}>ゲスト</span>
              )}
            </p>
          )}
        </div>
      </div>
      {profile.kind === "cpu" && profile.cpuProfile && (
        <p className="m-0 text-sm">
          CPU Lv{profile.cpuProfile.level}・{profile.cpuProfile.style}
        </p>
      )}
      {profile.kind === "account" ? (
        <>
          {!profile.isGuest && (
            <ProfileDetails
              profileMessage={profile.profileMessage}
              favoriteGames={profile.favoriteGames}
            />
          )}
          <div>
            <p className="m-0 text-xs font-semibold">
              {gameCatalog[game].name}
              {gameCatalog[game].hasModes && `・${mode === "singles" ? "シングルス" : "ダブルス"}`}
            </p>
            <p className="m-0 text-xs text-muted">{statsScopeLabel(game, mode)}</p>
          </div>
          <p className="m-0 text-xs tabular-nums wrap-anywhere">
            {formatPlayerStatsSummary(profile.stats, mode)}
          </p>
          {duelRating && (
            <div className="text-sm">
              <p className="m-0 font-semibold tabular-nums">
                {gameCatalog[game].name}レート {Math.round(duelRating.rating)}
              </p>
              {!duelRating.humanPlayed && <p className="m-0 text-xs text-muted">対人戦未経験</p>}
            </div>
          )}
          {gameCatalog[game].hasModes && mode === "singles" && (
            <PlayerBadges game={game} badges={profile.badges} />
          )}
        </>
      ) : (
        <p className="m-0 text-sm text-muted">
          {profile.kind === "guest" ? "ゲスト／ID・戦績なし" : "戦績集計対象外"}
        </p>
      )}
    </div>
  );
}
