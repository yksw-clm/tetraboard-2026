import { TournamentEntrance } from "../tournaments/TournamentEntrance";
import { LobbyFooter } from "./LobbyFooter";
import { RecentMatches } from "../matches/RecentMatches";
import { LobbyBoardPreview } from "./LobbyBoardPreview";
import { AppButton } from "../../shared/ui/AppButton";

import { type RoomTimeControl, type RoomMode, type CpuLevel } from "@tetraboard/protocol";
import { Fragment, useEffect, useState, type ReactNode } from "react";
import { AccountMenu } from "../account/AccountMenu";
import { AppHeader } from "../../shared/ui/AppHeader";
import { gameCatalog, type GameId } from "@tetraboard/protocol/games";
import { appThemeClasses, gameThemes } from "../../shared/ui/appTheme";
import { HowToPlayDialog } from "./HowToPlayDialog";
import { AppIcon } from "../../shared/ui/AppIcon";
import { RoomEntryDialog } from "./RoomEntryDialog";
import { type RoomEntryIntent } from "./useRoomEntry";
import type { RegistrationEntryDraft } from "../account/registrationReturn";
import { FeedbackEntry } from "../feedback/FeedbackEntry";
import { useLocation, useNavigate } from "react-router";
import { LobbyAnnouncement } from "./LobbyAnnouncement";
import { GameIntroduction } from "../../seo/GameIntroduction";

type Props = {
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
  renderRooms: (
    onJoin: (roomId: string, humanOnly?: boolean, instanceId?: string) => void,
  ) => ReactNode;
  rankings?: ReactNode;
  onNameChange: (value: string) => void;
  onRoomCodeChange: (value: string) => void;
  onModeChange: (mode: RoomMode) => void;
  onTimeControlChange: (value: RoomTimeControl) => void;
  onThreePlayerAttackChange?: (prohibited: boolean) => void;
  onClearMessage: () => void;
  onSubmitRoom?: (intent: RoomEntryIntent, roomId?: string, instanceId?: string) => void;
};

const gameDescriptions = {
  "four-gomoku": "4色でつなぐ五連。ひとりでも、チームでも。",
  gomoku: "五つの石をつなぐ、黒と白の真剣勝負。",
  reversi: "黒と白で楽しむリバーシ。",
  shogi: "先手と後手で楽しむ将棋。",
  "four-reversi": "4色で楽しむリバーシ。",
  "four-shogi": "4方向から楽しむ将棋。",
} satisfies Record<GameId, string>;

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
    homeTo: gameCatalog[props.game].lobbyPath,
    description: gameDescriptions[props.game],
    theme: gameThemes[props.game],
  };

  function openEntry(
    intent: RoomEntryIntent,
    roomId?: string,
    humanOnly?: boolean,
    instanceId?: string,
  ): void {
    props.onClearMessage();
    setDialog({ type: "entry", intent, roomId, humanOnly, instanceId });
  }

  function closeDialog(): void {
    if (props.isSubmitting === null) setDialog(null);
  }

  const sections = {
    rooms: (
      <div
        key="rooms"
        className="min-w-0 [@media(min-width:768px)]:row-span-2 [@media(min-width:768px)]:self-stretch"
      >
        {props.renderRooms((roomId, humanOnly, instanceId) =>
          openEntry("join", roomId, humanOnly, instanceId),
        )}
      </div>
    ),
    matches: <RecentMatches key={`matches:${props.game}`} game={props.game} />,
    rankings: props.rankings && <Fragment key="rankings">{props.rankings}</Fragment>,
  };
  const order = ["rooms", "rankings", "matches"] as const;

  return (
    <div className="app-theme min-h-dvh text-ink text-[15px] leading-[1.6]">
      <AppHeader homeTo="/" homeLabel={`TetraBoard ${game.title}のロビー`} theme={game.theme}>
        <AccountMenu lobbyGame={props.game} />
      </AppHeader>
      <div
        className={`lobby-background text-ink min-h-[calc(100dvh-69px)] [@media(max-width:650px)]:min-h-[calc(100dvh-61px)] ${appThemeClasses[game.theme]}`}
      >
        <main className="flex flex-col gap-[22px] max-w-[1148px] mx-auto px-6 pt-6 [@media(max-width:650px)]:gap-[18px] [@media(max-width:650px)]:px-5 [@media(max-width:650px)]:pt-5">
          <div className="flex items-center justify-between gap-5 [@media(max-width:767px)]:flex-col [@media(max-width:767px)]:items-stretch [@media(max-width:767px)]:gap-2">
            <div className="flex min-w-0 items-center gap-5 [@media(max-width:767px)]:gap-3">
              <span className="grid size-16 shrink-0 place-items-center">
                <LobbyBoardPreview game={props.game} compact className="!w-12" />
              </span>
              <div className="min-w-0">
                <h1 className="text-[36px] leading-[1.35] tracking-[0.02em] [@media(max-width:767px)]:text-[27px]">
                  {game.title}
                </h1>
                <p className="mt-[6px]! text-muted text-sm [@media(max-width:767px)]:hidden">
                  ひとりでも、友達とでも。{game.description}
                </p>
              </div>
            </div>
            <div className="flex items-center justify-between gap-2">
              <p className="hidden text-muted text-xs [@media(max-width:767px)]:block">
                ひとりでも、友達とでも。
                <br />
                {game.description}
              </p>
              <AppButton
                className="px-[9px] text-[13px]"
                appearance="quiet"
                type="button"
                onPress={() => setDialog({ type: "rules" })}
              >
                <AppIcon name="book" />
                遊び方
              </AppButton>
            </div>
          </div>

          {props.game === "four-shogi" && <TournamentEntrance />}
          <LobbyAnnouncement game={props.game} />
          <section
            aria-label="対局を始める"
            className="grid w-full max-w-[576px] grid-cols-2 gap-3 [@media(max-width:400px)]:grid-cols-1"
          >
            <AppButton
              className="w-full min-w-0 min-h-12 gap-2 px-3"
              onPress={() => openEntry("quick")}
            >
              <AppIcon name="robot" />
              CPUと遊ぶ
            </AppButton>
            <AppButton
              className="w-full min-w-0 min-h-12 gap-2 px-3"
              appearance="secondary"
              onPress={() => openEntry("create")}
            >
              <AppIcon name="plus" />
              公開ルームを作る
            </AppButton>
          </section>
          <div className="grid grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)] items-start gap-5 [@media(max-width:767px)]:grid-cols-1 [@media(max-width:767px)]:gap-[18px]">
            {order.map((section) => sections[section])}
          </div>
          <GameIntroduction game={props.game} />
          <LobbyFooter>
            <FeedbackEntry context={{ page: "lobby", game: props.game }} theme={game.theme} />
          </LobbyFooter>
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
          onSubmit={() => props.onSubmitRoom?.(dialog.intent, dialog.roomId, dialog.instanceId)}
          onClose={closeDialog}
        />
      )}
      {dialog?.type === "rules" && <HowToPlayDialog game={props.game} onClose={closeDialog} />}
    </div>
  );
}
