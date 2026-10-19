import type { GameId } from "@tetraboard/protocol/games";
import { gameCatalog } from "@tetraboard/protocol/games";
import type { PlayerProfile, RoomMode } from "@tetraboard/protocol";
import { PlayerAvatar } from "../room/PlayerAvatar";
import { formatPlayerStatsSummary } from "./playerStatsSummary";
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
              {profile.isGuest ? "ゲスト" : `@${profile.username}`}
            </p>
          )}
        </div>
      </div>
      {profile.kind === "account" ? (
        <>
          <div>
            <p className="m-0 text-xs font-semibold">
              {gameCatalog[game].name}
              {gameCatalog[game].hasModes && `・${mode === "singles" ? "シングルス" : "ダブルス"}`}
            </p>
            <p className="m-0 text-xs text-muted">対人戦のみ集計</p>
          </div>
          <p className="m-0 text-xs tabular-nums wrap-anywhere">
            {formatPlayerStatsSummary(profile.stats, mode)}
          </p>
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
