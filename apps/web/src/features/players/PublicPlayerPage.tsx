import {
  getPlayerGameRatingsContract,
  getPlayerProfileContract,
  listPlayerMatchesContract,
  playerProfileReferenceSchema,
  usernameSchema,
  type PlayerProfileQueryTarget,
  type RoomMode,
} from "@tetraboard/protocol";
import { defaultGameId, gameCatalog, isGameId, type GameId } from "@tetraboard/protocol/games";
import { useCallback, useEffect, useState } from "react";
import { Navigate, useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { AppButton } from "../../shared/ui/AppButton";
import { AppCard } from "../../shared/ui/AppCard";
import { AppHeader } from "../../shared/ui/AppHeader";
import { AppPageLoading } from "../../shared/ui/AppPageState";
import { appThemeClasses, gameThemes } from "../../shared/ui/appTheme";
import { appPageWidthClasses } from "../../shared/ui/pageLayout";
import { useAccount } from "../account/useAccount";
import { createAccountSelection } from "../account/useAccountSelection";
import { MatchHistoryCard } from "../matches/MatchHistoryCard";
import { PlayerAvatar } from "../room/PlayerAvatar";
import { PlayerProfileId, PublicPlayerStats, type PublicAccountProfile } from "./PlayerProfileCard";
import { ProfileDetails } from "./ProfileDetails";
import { ProfileGameButtons } from "./ProfileGameButtons";
import { playerGameQuery, playerProfileApiUrl, playerUsernamePath } from "./playerProfileQuery";
import { usePublicPlayerRequest } from "./usePublicPlayerRequest";

type PublicPlayerTarget = Extract<PlayerProfileQueryTarget, { source: "profile" | "username" }>;

function publicPlayerTarget(profileId?: string, handle?: string): PublicPlayerTarget | null {
  if (handle?.startsWith("@")) {
    const result = usernameSchema.safeParse(handle);
    return result.success ? { source: "username", username: result.data } : null;
  }
  const result = playerProfileReferenceSchema.safeParse({ source: "profile", profileId });
  return result.data ?? null;
}

export function PublicPlayerPage() {
  const { profileId, handle } = useParams();
  const { state } = useLocation();
  const navigate = useNavigate();
  const target = publicPlayerTarget(profileId, handle);
  const expectedProfileId =
    target?.source === "username" && typeof state?.expectedProfileId === "string"
      ? state.expectedProfileId
      : undefined;
  const targetKey =
    target?.source === "username"
      ? `${playerUsernamePath(target.username)}:${expectedProfileId ?? ""}`
      : profileId;
  const [search, setSearch] = useSearchParams();
  const { user, loading } = useAccount();
  const backSteps =
    typeof state?.profileBackSteps === "number" &&
    Number.isSafeInteger(state.profileBackSteps) &&
    state.profileBackSteps > 0
      ? state.profileBackSteps
      : null;
  const [accountChecked, setAccountChecked] = useState(!loading);
  const [unavailableProfiles, setUnavailableProfiles] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const markUnavailable = useCallback(() => {
    if (targetKey) setUnavailableProfiles((profiles) => new Set(profiles).add(targetKey));
  }, [targetKey]);
  const selectedGame = search.get("game");
  const game = isGameId(selectedGame) ? selectedGame : defaultGameId;
  const mode =
    gameCatalog[game].hasModes && search.get("mode") === "doubles" ? "doubles" : "singles";
  const changeSelection = (nextGame: GameId, nextMode: RoomMode) => {
    // ゲーム・モードの履歴を残しながら、遷移元までの距離を引き継ぎます。
    setSearch(playerGameQuery(nextGame, nextMode), {
      state: backSteps === null ? state : { ...state, profileBackSteps: backSteps + 1 },
    });
  };

  if (!accountChecked && !loading) setAccountChecked(true);
  if (target?.source === "profile" && user?.profileId === target.profileId)
    return <OwnPlayerPage game={game} mode={mode} />;
  if (!accountChecked && loading && !user)
    return <AppPageLoading message="ログイン状態を確認しています…" />;

  const theme = gameThemes[game];

  return (
    <div className="app-theme flex min-h-dvh flex-col text-ink">
      <AppHeader homeTo="/" homeLabel="TetraBoard ロビー" theme={theme} />
      <div className={`lobby-background flex-1 text-ink ${appThemeClasses[theme]}`}>
        <main className={`${appPageWidthClasses} flex flex-col gap-5 py-6 sm:py-8`}>
          {target &&
            backSteps !== null &&
            (!expectedProfileId || user?.profileId !== expectedProfileId) && (
              <AppButton
                appearance="secondary"
                size="compact"
                className="self-start"
                onPress={() => void navigate(-backSteps)}
              >
                戻る
              </AppButton>
            )}
          {!target || (targetKey && unavailableProfiles.has(targetKey)) ? (
            <UnavailablePlayerCard />
          ) : (
            <PublicPlayerContent
              key={targetKey}
              target={target}
              expectedProfileId={expectedProfileId}
              game={game}
              mode={mode}
              onGameChange={(next) => changeSelection(next, "singles")}
              onModeChange={(next) => changeSelection(game, next)}
              onUnavailable={markUnavailable}
            />
          )}
        </main>
      </div>
    </div>
  );
}

function UnavailablePlayerCard() {
  return (
    <AppCard>
      <h1 className="m-0 text-xl font-bold">プレイヤーページ</h1>
      <p role="status" className="m-0">
        プロフィールを表示できません。
      </p>
    </AppCard>
  );
}

function OwnPlayerPage({ game, mode }: { game: GameId; mode: RoomMode }) {
  const accountSelection = createAccountSelection(game);
  accountSelection.modes[game] = mode;
  return <Navigate to="/account" replace state={{ accountSelection }} />;
}

function PublicPlayerContent({
  target,
  expectedProfileId,
  game,
  mode,
  onGameChange,
  onModeChange,
  onUnavailable,
}: {
  target: PublicPlayerTarget;
  expectedProfileId?: string;
  game: GameId;
  mode: RoomMode;
  onGameChange: (game: GameId) => void;
  onModeChange: (mode: RoomMode) => void;
  onUnavailable: () => void;
}) {
  const { user } = useAccount();
  const location = useLocation();
  const profile = usePublicPlayerRequest(
    playerProfileApiUrl(target, game, { includeRating: false }),
    getPlayerProfileContract.response,
    onUnavailable,
  );
  const account = profile.result.status === "ready" && profile.result.data;
  const resolvedPlayer =
    account &&
    account.kind === "account" &&
    account.game === game &&
    (target.source === "profile" || (!account.isGuest && account.username === target.username))
      ? account
      : null;
  const unexpectedOwner = Boolean(
    resolvedPlayer && expectedProfileId && resolvedPlayer.profileId !== expectedProfileId,
  );
  useEffect(() => {
    if (unexpectedOwner) onUnavailable();
  }, [unexpectedOwner, onUnavailable]);
  const player = unexpectedOwner ? null : resolvedPlayer;
  const ownProfile = player && user?.profileId === player.profileId;
  const canonicalPath =
    player && !player.isGuest && player.username ? playerUsernamePath(player.username) : null;
  const redirectToCanonical = canonicalPath && canonicalPath !== location.pathname;
  const legacyProfileId = target.source === "profile" ? target.profileId : null;
  const [confirmedProfileId, setConfirmedProfileId] = useState<string | null>(null);
  const playerProfileId = player && !player.isGuest ? player.profileId : null;
  // ゲーム切替中はレートの再取得を省き、表示は現行プロフィールの照合を待ちます。
  const ratingProfileId =
    profile.result.status === "loading" ? confirmedProfileId : playerProfileId;
  if (ratingProfileId !== confirmedProfileId) setConfirmedProfileId(ratingProfileId);
  const historyProfileId = player?.profileId ?? legacyProfileId;
  const ratingsRequestId = ratingProfileId ?? legacyProfileId;
  const leaving = ownProfile || redirectToCanonical;
  const history = usePublicPlayerRequest(
    historyProfileId && !leaving
      ? `/api${listPlayerMatchesContract.path.replace(":profileId", historyProfileId)}?${playerGameQuery(game, mode)}`
      : null,
    listPlayerMatchesContract.response,
    onUnavailable,
  );
  const ratings = usePublicPlayerRequest(
    ratingsRequestId && !leaving
      ? `/api${getPlayerGameRatingsContract.path.replace(":profileId", ratingsRequestId)}`
      : null,
    getPlayerGameRatingsContract.response,
  );
  const games =
    ratings.result.status === "ready" && ratings.result.data.profileId === playerProfileId
      ? ratings.result.data.games
      : null;
  if (ownProfile) return <OwnPlayerPage game={game} mode={mode} />;
  if (unexpectedOwner) return <UnavailablePlayerCard />;
  if (player && redirectToCanonical)
    return (
      <Navigate
        to={{ pathname: canonicalPath, search: location.search, hash: location.hash }}
        replace
        state={{
          ...location.state,
          expectedProfileId: target.source === "profile" ? player.profileId : expectedProfileId,
        }}
      />
    );
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
        <ProfileGameButtons
          game={game}
          onChange={onGameChange}
          ratingForGame={(id) => games?.[id]}
        />
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
            <PublicPlayerStats profile={player} game={game} mode={mode} showRating={false} />
          ) : (
            <PlayerRequestNotice loading={profile.result.status === "loading"} label="戦績" />
          )}
        </AppCard>
      </section>
      {historyProfileId && (
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
      )}
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
