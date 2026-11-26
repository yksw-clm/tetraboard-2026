import {
  getPlayerProfileContract,
  listPlayerMatchesContract,
  type RoomMode,
} from "@tetraboard/protocol";
import { defaultGameId, gameCatalog, isGameId, type GameId } from "@tetraboard/protocol/games";
import { useCallback, useState } from "react";
import { useParams, useSearchParams } from "react-router";
import { AppButton } from "../../shared/ui/AppButton";
import { AppCard } from "../../shared/ui/AppCard";
import { AppHeader } from "../../shared/ui/AppHeader";
import { appThemeClasses, gameThemes } from "../../shared/ui/appTheme";
import { appPageWidthClasses } from "../../shared/ui/pageLayout";
import { MatchHistoryCard } from "../matches/MatchHistoryCard";
import { PlayerAvatar } from "../room/PlayerAvatar";
import { PlayerProfileId, PublicPlayerStats, type PublicAccountProfile } from "./PlayerProfileCard";
import { ProfileDetails } from "./ProfileDetails";
import { ProfileGameButtons } from "./ProfileGameButtons";
import { playerGameQuery, playerProfileApiUrl } from "./playerProfileQuery";
import { usePublicPlayerRequest } from "./usePublicPlayerRequest";

export function PublicPlayerPage() {
  const { profileId = "" } = useParams();
  const [search, setSearch] = useSearchParams();
  const [unavailableProfiles, setUnavailableProfiles] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const markUnavailable = useCallback(
    () => setUnavailableProfiles((profiles) => new Set(profiles).add(profileId)),
    [profileId],
  );
  const selectedGame = search.get("game");
  const game = isGameId(selectedGame) ? selectedGame : defaultGameId;
  const mode =
    gameCatalog[game].hasModes && search.get("mode") === "doubles" ? "doubles" : "singles";
  const theme = gameThemes[game];

  return (
    <div className={`app-theme lobby-background min-h-dvh text-ink ${appThemeClasses[theme]}`}>
      <AppHeader homeTo="/" homeLabel="TetraBoard ロビー" theme={theme} showAccountMenu />
      <main className={`${appPageWidthClasses} flex flex-col gap-5 py-6 sm:py-8`}>
        {unavailableProfiles.has(profileId) ? (
          <AppCard>
            <h1 className="m-0 text-xl font-bold">プレイヤーページ</h1>
            <p role="status" className="m-0">
              プロフィールを表示できません。
            </p>
          </AppCard>
        ) : (
          <PublicPlayerContent
            key={profileId}
            profileId={profileId}
            game={game}
            mode={mode}
            onGameChange={(next) => setSearch(playerGameQuery(next, "singles"))}
            onModeChange={(next) => setSearch(playerGameQuery(game, next))}
            onUnavailable={markUnavailable}
          />
        )}
      </main>
    </div>
  );
}

function PublicPlayerContent({
  profileId,
  game,
  mode,
  onGameChange,
  onModeChange,
  onUnavailable,
}: {
  profileId: string;
  game: GameId;
  mode: RoomMode;
  onGameChange: (game: GameId) => void;
  onModeChange: (mode: RoomMode) => void;
  onUnavailable: () => void;
}) {
  const profile = usePublicPlayerRequest(
    playerProfileApiUrl({ source: "profile", profileId }, game),
    getPlayerProfileContract.response,
    onUnavailable,
  );
  const history = usePublicPlayerRequest(
    `/api${listPlayerMatchesContract.path.replace(":profileId", encodeURIComponent(profileId))}?${playerGameQuery(game, mode)}`,
    listPlayerMatchesContract.response,
    onUnavailable,
  );
  const account = profile.result.status === "ready" && profile.result.data;
  const player = account && account.kind === "account" && account.game === game ? account : null;
  return (
    <>
      <AppCard>
        {player ? (
          <PlayerIdentity profile={player} />
        ) : (
          <>
            <h1 className="m-0 text-xl font-bold">プレイヤーページ</h1>
            <PlayerRequestNotice
              loading={profile.result.status === "loading"}
              label="プレイヤー情報"
              onRetry={profile.retry}
            />
          </>
        )}
      </AppCard>
      <div className="flex flex-col gap-3">
        <ProfileGameButtons game={game} onChange={onGameChange} />
        {gameCatalog[game].hasModes && (
          <div role="group" aria-label="プロフィールの対局モード" className="flex flex-wrap gap-2">
            {(["singles", "doubles"] as const).map((option) => (
              <AppButton
                key={option}
                size="compact"
                appearance={mode === option ? "primary" : "secondary"}
                aria-pressed={mode === option}
                className="min-h-11"
                onPress={() => {
                  if (mode !== option) onModeChange(option);
                }}
              >
                {option === "singles" ? "シングルス" : "ダブルス"}
              </AppButton>
            ))}
          </div>
        )}
      </div>
      <section aria-labelledby="public-player-stats">
        <AppCard>
          <h2 id="public-player-stats" className="m-0 text-lg font-bold">
            戦績
          </h2>
          {player ? (
            <PublicPlayerStats
              profile={player}
              game={game}
              mode={mode}
              showRating={player.rating?.timing === "current"}
            />
          ) : (
            <PlayerRequestNotice loading={profile.result.status === "loading"} label="戦績" />
          )}
        </AppCard>
      </section>
      <section aria-labelledby="public-player-matches">
        <AppCard>
          <h2 id="public-player-matches" className="m-0 text-lg font-bold">
            最近の公開棋譜（最大20局）
          </h2>
          {history.result.status === "ready" ? (
            history.result.data.matches.length ? (
              <div className="grid min-w-0 gap-3 lg:grid-cols-2">
                {history.result.data.matches.map((match) => (
                  <MatchHistoryCard
                    key={match.id}
                    match={match}
                    to={`/matches/${match.id}`}
                    showGame={false}
                  />
                ))}
              </div>
            ) : (
              <p className="m-0 text-sm text-muted">このゲーム・モードの公開棋譜はありません。</p>
            )
          ) : (
            <PlayerRequestNotice
              loading={history.result.status === "loading"}
              label="公開棋譜"
              onRetry={history.retry}
            />
          )}
        </AppCard>
      </section>
    </>
  );
}

function PlayerIdentity({ profile }: { profile: PublicAccountProfile }) {
  return (
    <>
      <div className="flex min-w-0 items-center gap-3">
        <PlayerAvatar
          appearance={{ kind: "human", avatarUrl: profile.avatarUrl }}
          className="size-14"
        />
        <div className="min-w-0">
          <h1 className="m-0 text-xl font-bold wrap-anywhere">{profile.name}</h1>
          <PlayerProfileId profile={profile} />
        </div>
      </div>
      <ProfileDetails
        profileMessage={profile.profileMessage}
        favoriteGames={profile.favoriteGames}
      />
    </>
  );
}

function PlayerRequestNotice({
  loading,
  label,
  onRetry,
}: {
  loading: boolean;
  label: string;
  onRetry?: () => void;
}) {
  return loading ? (
    <p role="status" className="m-0 text-sm text-muted">
      {label}を読み込んでいます…
    </p>
  ) : (
    <div className="flex flex-col items-start gap-2">
      <p role={onRetry ? "alert" : undefined} className="m-0 text-sm text-danger">
        {label}を取得できませんでした。
      </p>
      {onRetry && (
        <AppButton size="compact" appearance="secondary" onPress={onRetry}>
          再試行
        </AppButton>
      )}
    </div>
  );
}
