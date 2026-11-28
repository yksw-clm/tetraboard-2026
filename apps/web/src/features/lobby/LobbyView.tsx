import { TournamentEntranceContent } from "../tournaments/TournamentEntrance";
import { TournamentList } from "../tournaments/TournamentList";
import { LobbyFooter } from "./LobbyFooter";
import { RecentMatches } from "../matches/RecentMatches";
import { LobbyGameTitle } from "./LobbyGameTitle";
import { LobbyRankings } from "./LobbyRankings";
import { MobileLobbyHeader } from "./MobileLobbyHeader";
import { readLobbyTab, useMobileLobby } from "./useMobileLobby";
import { useLobbyTournaments } from "../tournaments/useLobbyTournaments";
import { useNextLobbyTournament } from "../tournaments/useActiveTournaments";
import { LobbyPostPreview } from "./LobbyPostPreview";
import { AppButton } from "../../shared/ui/AppButton";

import {
  type RoomTimeControl,
  type RoomMode,
  type CpuLevel,
  type AvatarPresetId,
} from "@tetraboard/protocol";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { AccountMenu } from "../account/AccountMenu";
import { AppHeader } from "../../shared/ui/AppHeader";
import { appPageWidthClasses } from "../../shared/ui/pageLayout";
import { isRatedMatchmakingGame } from "@tetraboard/protocol";
import { gameCatalog, type GameId } from "@tetraboard/protocol/games";
import { appThemeClasses, gameThemes } from "../../shared/ui/appTheme";
import { HowToPlayDialog } from "./HowToPlayDialog";
import { AppIcon } from "../../shared/ui/AppIcon";
import { RoomEntryDialog } from "./RoomEntryDialog";
import { RoomEntryMessage } from "./RoomEntryMessage";
import { type RoomEntryIntent } from "./useRoomEntry";
import type { RegistrationEntryDraft } from "../account/registrationReturn";
import { FeedbackEntry } from "../feedback/FeedbackEntry";
import { useLocation, useNavigate } from "react-router";
import { LobbyAnnouncement } from "./LobbyAnnouncement";
import { GameIntroduction } from "../../seo/GameIntroduction";

type Props = {
  showRatedMatchmaking?: boolean;
  registrationDraft?: RegistrationEntryDraft;
  game: GameId;
  name: string;
  roomCode: string;
  mode: RoomMode;
  cpuLevel: CpuLevel;
  onCpuLevelChange: (level: CpuLevel) => void;
  timeControl: RoomTimeControl;
  threePlayerAttackProhibited?: boolean;
  forbiddenRules?: boolean;
  onForbiddenRulesChange?: (enabled: boolean) => void;
  isSubmitting: RoomEntryIntent | null;
  message: string | null;
  entryFromResult?: boolean;
  renderRooms: (
    onJoin: (roomId: string, humanOnly?: boolean, instanceId?: string) => void,
  ) => ReactNode;
  onNameChange: (value: string) => void;
  onRoomCodeChange: (value: string) => void;
  onModeChange: (mode: RoomMode) => void;
  onTimeControlChange: (value: RoomTimeControl) => void;
  onThreePlayerAttackChange?: (prohibited: boolean) => void;
  onClearMessage: () => void;
  onSubmitRoom?: (
    intent: RoomEntryIntent,
    roomId?: string,
    instanceId?: string,
    avatarPresetId?: AvatarPresetId,
  ) => void;
};

type ActiveDialog =
  | {
      type: "entry";
      intent: RoomEntryIntent;
      roomId?: string;
      humanOnly?: boolean;
      instanceId?: string;
    }
  | { type: "rules" }
  | null;

export function LobbyView(props: Props) {
  const location = useLocation();
  const navigate = useNavigate();
  const mobile = useMobileLobby();
  const tab = readLobbyTab(location.search);
  const play = !mobile || tab === "play";
  const showRankings = !mobile || tab === "rankings";
  const showTournaments = !mobile || tab === "tournaments";
  const rankingsTarget = useRef<HTMLDivElement>(null);
  const tournamentTarget = useRef<HTMLDivElement>(null);
  const tournaments = useLobbyTournaments(props.game);
  const nextTournament = useNextLobbyTournament(props.game);
  const entranceIds = new Set(
    [...tournaments.current, ...tournaments.upcoming]
      .filter(({ status }) => status === "active" || status === "upcoming")
      .map(({ id }) => id),
  );
  if (mobile && nextTournament) entranceIds.add(nextTournament.id);
  useLayoutEffect(() => {
    if (mobile) return;
    const target =
      tab === "rankings" ? rankingsTarget : tab === "tournaments" ? tournamentTarget : null;
    target?.current?.scrollIntoView();
  }, [mobile, tab]);
  const createRequested = location.state?.roomEntryIntent === "create";
  useEffect(() => {
    if (!createRequested) return;
    const { roomEntryIntent: _intent, ...state } = location.state;
    void navigate(location.pathname + location.search + location.hash, { replace: true, state });
  }, [createRequested, location, navigate]);
  const [dialog, setDialog] = useState<ActiveDialog>(() =>
    props.registrationDraft
      ? {
          type: "entry",
          intent: props.registrationDraft.intent,
          roomId: props.registrationDraft.selectedRoomId,
          humanOnly: props.registrationDraft.humanOnly,
        }
      : createRequested
        ? { type: "entry", intent: "create" }
        : null,
  );
  const game = {
    title: gameCatalog[props.game].name,
    theme: gameThemes[props.game],
  };
  const ratedMatch = isRatedMatchmakingGame(props.game) && props.showRatedMatchmaking !== false;
  const creatingFromResult = props.entryFromResult && props.isSubmitting === "create";

  function openMatchmaking(): void {
    const search = new URLSearchParams(location.search);
    search.set("matchmaking", "1");
    void navigate(
      {
        pathname: location.pathname,
        search: search.toString(),
        hash: location.hash,
      },
      { state: { matchmakingFromLobby: true } },
    );
  }

  function openEntry(
    intent: RoomEntryIntent,
    roomId?: string,
    humanOnly?: boolean,
    instanceId?: string,
  ): void {
    if (creatingFromResult) return;
    props.onClearMessage();
    setDialog({ type: "entry", intent, roomId, humanOnly, instanceId });
  }

  function closeDialog(): void {
    if (props.isSubmitting === null) setDialog(null);
  }

  return (
    <div className="app-theme min-h-dvh text-ink text-[15px] leading-[1.6]">
      <AppHeader homeTo="/" homeLabel={`TetraBoard ${game.title}のロビー`} theme={game.theme}>
        <AccountMenu lobbyGame={props.game} />
      </AppHeader>
      <div
        className={`lobby-background text-ink min-h-[calc(100dvh-69px)] [@media(max-width:650px)]:min-h-[calc(100dvh-61px)] ${appThemeClasses[game.theme]}`}
      >
        <main
          className={`${appPageWidthClasses} flex flex-col gap-[22px] pt-6 [@media(max-width:767px)]:gap-2.5 [@media(max-width:767px)]:pt-3`}
        >
          {mobile && (
            <MobileLobbyHeader
              game={props.game}
              selected={tab}
              onRules={() => setDialog({ type: "rules" })}
            />
          )}
          <div className="flex flex-col gap-[22px] [@media(max-width:650px)]:gap-[18px] [@media(min-width:768px)]:contents">
            <div className="flex items-center justify-between gap-5 [@media(max-width:767px)]:contents">
              {!mobile && (
                <LobbyGameTitle game={props.game} onRules={() => setDialog({ type: "rules" })} />
              )}
              {play && (
                <section
                  aria-label="対局を始める"
                  className={`grid w-full max-w-[576px] grid-cols-2 gap-3 [@media(min-width:768px)]:w-[min(48%,28rem)] [@media(min-width:768px)]:shrink-0 ${ratedMatch ? "" : "[@media(max-width:400px)]:grid-cols-1"}`}
                >
                  <AppButton
                    className="w-full min-w-0 min-h-12 gap-2 px-3 whitespace-normal"
                    onPress={() => openEntry("quick")}
                  >
                    <AppIcon name="robot" />
                    CPUと遊ぶ
                  </AppButton>
                  <AppButton
                    className="w-full min-w-0 min-h-12 gap-2 px-3 whitespace-normal"
                    appearance="secondary"
                    isPending={creatingFromResult}
                    onPress={() => openEntry("create")}
                  >
                    <AppIcon name="plus" />
                    公開ルームを作る
                  </AppButton>
                  {ratedMatch && (
                    <AppButton className="col-span-full w-full min-h-12" onPress={openMatchmaking}>
                      <AppIcon name="shuffle" />
                      レート戦
                    </AppButton>
                  )}
                </section>
              )}
            </div>

            {dialog === null && props.entryFromResult && props.message && (
              <RoomEntryMessage message={props.message} />
            )}
            <LobbyAnnouncement game={props.game} />
            {showTournaments && (
              <TournamentEntranceContent game={props.game} state={tournaments} mobile={mobile} />
            )}
            <div className="grid grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)] items-start gap-5 [@media(max-width:767px)]:grid-cols-1 [@media(max-width:767px)]:gap-[18px]">
              {play && (
                <div className="min-w-0 [@media(min-width:768px)]:row-span-2 [@media(min-width:768px)]:self-stretch">
                  {props.renderRooms((roomId, humanOnly, instanceId) =>
                    openEntry("join", roomId, humanOnly, instanceId),
                  )}
                </div>
              )}
              <div ref={rankingsTarget} hidden={!showRankings} className="min-w-0">
                <LobbyRankings game={props.game} theme={game.theme} inline={mobile} />
              </div>
              {play && <RecentMatches key={`matches:${props.game}`} game={props.game} />}
              <LobbyPostPreview
                key={`posts:${props.game}`}
                game={props.game}
                launchBlocked={dialog !== null || props.isSubmitting !== null || createRequested}
                announcementOnly={mobile}
              />
              {showTournaments && (
                <div
                  ref={tournamentTarget}
                  className="min-w-0 [@media(min-width:768px)]:col-span-2 [@media(min-width:768px)]:col-start-1 [@media(min-width:768px)]:row-start-4"
                >
                  <TournamentList
                    key={props.game}
                    game={props.game}
                    lobbyEntranceIds={mobile ? entranceIds : undefined}
                  />
                </div>
              )}
            </div>
            <GameIntroduction game={props.game} />
            <LobbyFooter>
              <FeedbackEntry context={{ page: "lobby", game: props.game }} theme={game.theme} />
            </LobbyFooter>
          </div>
        </main>
      </div>
      {dialog?.type === "entry" && (
        <RoomEntryDialog
          game={props.game}
          intent={dialog.intent}
          theme={game.theme}
          forbiddenRules={props.forbiddenRules}
          onForbiddenRulesChange={props.onForbiddenRulesChange}
          threePlayerAttackProhibited={props.threePlayerAttackProhibited}
          selectedRoomId={dialog.roomId}
          name={props.name}
          roomCode={props.roomCode}
          mode={props.mode}
          cpuLevel={props.cpuLevel}
          onCpuLevelChange={props.onCpuLevelChange}
          timeControl={props.timeControl}
          onTimeControlChange={props.onTimeControlChange}
          busy={props.isSubmitting !== null}
          message={props.message}
          onNameChange={props.onNameChange}
          onRoomCodeChange={props.onRoomCodeChange}
          onModeChange={props.onModeChange}
          onThreePlayerAttackChange={props.onThreePlayerAttackChange}
          onSubmit={(avatarPresetId) =>
            props.onSubmitRoom?.(dialog.intent, dialog.roomId, dialog.instanceId, avatarPresetId)
          }
          onClose={closeDialog}
        />
      )}
      {dialog?.type === "rules" && <HowToPlayDialog game={props.game} onClose={closeDialog} />}
    </div>
  );
}
