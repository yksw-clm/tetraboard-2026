import type { GameId } from "@tetraboard/protocol/games";
import { gameCatalog } from "@tetraboard/protocol/games";
import type { PlayerProfile, ProfileRating, RoomMode } from "@tetraboard/protocol";
import { PlayerAvatar } from "../room/PlayerAvatar";
import { formatPlayerStatsSummary } from "./playerStatsSummary";
import { AppButton } from "../../shared/ui/AppButton";
import { AppIcon } from "../../shared/ui/AppIcon";
import type { ProfileState } from "./playerProfileStore";
import { PlayerBadges } from "../badges/PlayerBadges";
import { ProfileDetails } from "./ProfileDetails";
import { includesRatedStats, statsScopeLabel } from "../account/statsPresentation";
import { PlayerPageLink } from "./PlayerPageLink";
import { useId } from "react";
import { useMatch } from "react-router";

export type PublicAccountProfile = Extract<PlayerProfile, { kind: "account" }>;

export function PlayerProfileCard({
  state,
  localProfile,
  game,
  mode,
  onRetry,
  showRating = true,
}: {
  state: ProfileState;
  localProfile?: PlayerProfile;
  game: GameId;
  mode: RoomMode;
  onRetry: () => void;
  showRating?: boolean;
}) {
  const profile = state.profile ?? localProfile;
  if (!profile || (state.loading && !localProfile))
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
  const name = profile.kind === "cpu" ? (profile.name ?? `CPU Lv${profile.level}`) : profile.name;
  const linkedProfile = state.profile?.kind === "account" ? state.profile : null;
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
          {linkedProfile ? (
            <PlayerNameLink profile={linkedProfile} game={game} mode={mode} />
          ) : (
            <p className="m-0 font-bold wrap-anywhere">{name}</p>
          )}
          {profile.kind === "account" && <PlayerProfileId profile={profile} />}
        </div>
      </div>
      {profile.kind === "cpu" && profile.cpuProfile && (
        <p className="m-0 text-sm">
          CPU Lv{profile.cpuProfile.level}・{profile.cpuProfile.style}
        </p>
      )}
      {profile.kind === "account" ? (
        <>
          <ProfileDetails
            profileMessage={profile.isGuest ? undefined : profile.profileMessage}
            favoriteGames={profile.isGuest ? undefined : profile.favoriteGames}
          >
            {showRating && profile.rating && <ProfileRatingLabel rating={profile.rating} />}
          </ProfileDetails>
          <PublicPlayerStats
            profile={profile}
            game={game}
            mode={mode}
            hideRatedScope
            gameLabel={
              gameCatalog[game].name +
              (gameCatalog[game].hasModes
                ? `・${mode === "singles" ? "シングルス" : "ダブルス"}`
                : "")
            }
          />
        </>
      ) : (
        <>
          {showRating && profile.kind === "cpu" && profile.rating && (
            <ProfileRatingLabel rating={profile.rating} />
          )}
          <p className="m-0 text-sm text-muted">
            {profile.kind === "guest" ? "ゲスト／ID・戦績なし" : "戦績集計対象外"}
          </p>
          {localProfile && state.loading && (
            <p role="status" className="m-0 text-sm">
              プレイヤー情報を読み込んでいます…
            </p>
          )}
          {localProfile && state.error && (
            <div>
              <p role="alert" className="m-0 text-sm">
                {state.error}
              </p>
              <AppButton size="compact" appearance="secondary" onPress={onRetry}>
                再試行
              </AppButton>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function PlayerNameLink({
  profile,
  game,
  mode,
}: {
  profile: PublicAccountProfile;
  game: GameId;
  mode: RoomMode;
}) {
  const isRoom = Boolean(useMatch("/rooms/:id"));
  const descriptionId = useId();
  return (
    <>
      <p className="m-0 font-bold wrap-anywhere">
        <PlayerPageLink
          profile={{
            profileId: profile.profileId,
            username: profile.isGuest ? null : profile.username,
          }}
          game={game}
          mode={mode}
          className="rounded-sm text-brand underline underline-offset-2 focus-visible:outline-[3px] focus-visible:outline-focus focus-visible:outline-offset-2"
          target={isRoom ? "_blank" : undefined}
          rel={isRoom ? "noopener noreferrer" : undefined}
          aria-describedby={isRoom ? descriptionId : undefined}
        >
          {profile.name}
        </PlayerPageLink>
      </p>
      {isRoom && (
        <p id={descriptionId} className="m-0 text-xs text-muted">
          新しいタブで開く
        </p>
      )}
    </>
  );
}

export function PlayerProfileId({ profile }: { profile: PublicAccountProfile }) {
  return (
    <p className="m-0 text-sm text-muted wrap-anywhere">
      {profile.username && `@${profile.username}`}
      {profile.isGuest && <span className={profile.username ? "ml-2" : undefined}>ゲスト</span>}
    </p>
  );
}

export function PublicPlayerStats({
  profile,
  game,
  mode,
  gameLabel,
  hideRatedScope = false,
}: {
  profile: PublicAccountProfile;
  game: GameId;
  mode: RoomMode;
  gameLabel?: string;
  hideRatedScope?: boolean;
}) {
  const showScope = !hideRatedScope || !includesRatedStats(game, mode);
  return (
    <div className="flex flex-col gap-3">
      <div>
        {gameLabel && <p className="m-0 text-xs font-semibold">{gameLabel}</p>}
        {showScope && <p className="m-0 text-xs text-muted">{statsScopeLabel(game, mode)}</p>}
      </div>
      <p className="m-0 text-xs tabular-nums wrap-anywhere">
        {formatPlayerStatsSummary(profile.stats, mode)}
      </p>
      {gameCatalog[game].hasModes && mode === "singles" && (
        <PlayerBadges game={game} badges={profile.badges} />
      )}
    </div>
  );
}

function ProfileRatingLabel({ rating }: { rating: ProfileRating }) {
  const label =
    rating.timing === "current"
      ? "現在のレート"
      : rating.timing === "reference"
        ? "基準レート"
        : "対局前レート";
  return (
    <p className="m-0 flex min-w-0 items-center gap-1.5 text-sm font-semibold tabular-nums">
      <AppIcon name="trophy" className="size-4" />
      <span className="sr-only">{label} </span>
      <span className="min-w-0 wrap-anywhere">
        {rating.status === "rated"
          ? Math.round(rating.rating)
          : rating.status === "placement"
            ? "認定中"
            : "記録なし"}
      </span>
    </p>
  );
}
