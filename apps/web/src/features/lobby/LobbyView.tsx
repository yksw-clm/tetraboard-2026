const previewStoneClasses = {
  black: "preview-stone-black",
  white: "preview-stone-white",
  red: "preview-stone-red",
  blue: "preview-stone-blue",
} as const;
import { AppCard } from "../../shared/ui/AppCard";
import { AppButton } from "../../shared/ui/AppButton";

import { type RoomMode } from "@tetraboard/protocol";
import { Fragment, useState, useSyncExternalStore, type ReactNode } from "react";
import { AccountMenu } from "../account/AccountMenu";
import { AppHeader } from "../../shared/ui/AppHeader";
import { fourReversiLobbyPath, fourShogiLobbyPath } from "../../app/paths";
import { appThemeClasses } from "../../shared/ui/appTheme";
import { GameLobbyNavigation } from "./GameLobbyNavigation";
import { HowToPlayDialog } from "./HowToPlayDialog";
import { AppIcon, type AppIconName } from "../../shared/ui/AppIcon";
import { RoomEntryDialog } from "./RoomEntryDialog";
import { type RoomEntryIntent } from "./useRoomEntry";
import type { RegistrationEntryDraft } from "../account/registrationReturn";

type Props = {
  registrationDraft?: RegistrationEntryDraft;
  game: "four-reversi" | "four-shogi";
  name: string;
  roomCode: string;
  mode: RoomMode;
  threePlayerAttackProhibited?: boolean;
  isSubmitting: RoomEntryIntent | null;
  message: string | null;
  renderRooms: (onJoin: (roomId: string, humanOnly?: boolean) => void) => ReactNode;
  rankings?: ReactNode;
  boardPreview?: ReactNode;
  onNameChange: (value: string) => void;
  onRoomCodeChange: (value: string) => void;
  onModeChange: (mode: RoomMode) => void;
  onThreePlayerAttackChange?: (prohibited: boolean) => void;
  onClearMessage: () => void;
  onSubmitRoom?: (intent: RoomEntryIntent, roomId?: string) => void;
};

const games = {
  "four-reversi": {
    title: "四人リバーシ",
    description: "4色で楽しむリバーシ。",
    homeTo: fourReversiLobbyPath,
    theme: "default",
  },
  "four-shogi": {
    title: "四人将棋",
    description: "4方向から楽しむ将棋。",
    homeTo: fourShogiLobbyPath,
    theme: "four-shogi",
  },
} as const;

type ActiveDialog =
  | { type: "entry"; intent: RoomEntryIntent; roomId?: string; humanOnly?: boolean }
  | { type: "rules" }
  | null;

const previewStones: Record<number, keyof typeof previewStoneClasses> = {
  19: "black",
  28: "black",
  35: "white",
  44: "white",
  27: "red",
  34: "red",
  29: "blue",
  36: "blue",
};

const mobileQuery = "(max-width: 767px)";
function subscribeToLobbyWidth(onChange: () => void) {
  const query = window.matchMedia(mobileQuery);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}
const isMobileWidth = () => window.matchMedia(mobileQuery).matches;

function LobbyEntryButton({
  title,
  description,
  icon,
  primary = false,
  onPress,
}: {
  title: string;
  description: string;
  icon: AppIconName;
  primary?: boolean;
  onPress: () => void;
}) {
  return (
    <AppButton
      className="w-full min-h-[72px] justify-between gap-3 px-[18px] py-3 text-left whitespace-normal"
      appearance={primary ? "primary" : "secondary"}
      type="button"
      onPress={onPress}
    >
      <span className="min-w-0 flex-1">
        <strong className="block text-base">{title}</strong>
        <span
          className={`mt-1 block text-xs font-normal ${primary ? "text-primary-foreground/85" : "text-muted"}`}
        >
          {description}
        </span>
      </span>
      <AppIcon name={icon} className="shrink-0" />
    </AppButton>
  );
}

export function LobbyView(props: Props) {
  const [dialog, setDialog] = useState<ActiveDialog>(() =>
    props.registrationDraft
      ? {
          type: "entry",
          intent: props.registrationDraft.intent,
          roomId: props.registrationDraft.selectedRoomId,
          humanOnly: props.registrationDraft.humanOnly,
        }
      : null,
  );
  const mobile = useSyncExternalStore(subscribeToLobbyWidth, isMobileWidth);
  const game = games[props.game];

  function openEntry(intent: RoomEntryIntent, roomId?: string, humanOnly?: boolean): void {
    props.onClearMessage();
    setDialog({ type: "entry", intent, roomId, humanOnly });
  }

  function closeDialog(): void {
    if (props.isSubmitting === null) setDialog(null);
  }

  // 同じ親内のkey付き領域を並べ替え、幅変更でもランキングの状態を保持します。
  const sections = {
    play: (
      <section key="play" aria-label="対局を始める" className="min-w-0">
        <AppCard className="lobby-quick-background h-full gap-3 p-5 border-lobby-play-line">
          <h2 className="text-lg font-bold">一人で遊ぶ</h2>
          <LobbyEntryButton
            title="すぐ遊ぶ"
            description="CPU3人と対戦"
            icon="arrow"
            primary
            onPress={() => openEntry("quick")}
          />
          <h2 className="mt-2! text-lg font-bold">みんなで遊ぶ</h2>
          <LobbyEntryButton
            title="ルームを作る"
            description="友達を招待して、一緒に対戦"
            icon="plus"
            onPress={() => openEntry("create")}
          />
          <LobbyEntryButton
            title="ルーム番号で参加"
            description="5桁の番号を入力して合流"
            icon="join"
            onPress={() => openEntry("join")}
          />
        </AppCard>
      </section>
    ),
    rooms: (
      <Fragment key="rooms">
        {props.renderRooms((roomId, humanOnly) => openEntry("join", roomId, humanOnly))}
      </Fragment>
    ),
    rankings: props.rankings && <Fragment key="rankings">{props.rankings}</Fragment>,
  };
  const order = mobile
    ? (["play", "rooms", "rankings"] as const)
    : (["play", "rankings", "rooms"] as const);

  return (
    <div className="app-theme min-h-dvh text-ink text-[15px] leading-[1.6]">
      <AppHeader homeTo={game.homeTo} homeLabel={`TetraBoard ${game.title}のロビー`}>
        <AccountMenu />
      </AppHeader>
      <div
        className={`lobby-background text-ink min-h-[calc(100dvh-69px)] [@media(max-width:650px)]:min-h-[calc(100dvh-61px)] ${appThemeClasses[game.theme]}`}
      >
        <GameLobbyNavigation />
        <main className="flex flex-col gap-[22px] max-w-[1148px] mx-auto px-6 pt-6 [@media(max-width:650px)]:gap-[18px] [@media(max-width:650px)]:px-5 [@media(max-width:650px)]:pt-5">
          <div className="flex items-center justify-between gap-5 [@media(max-width:767px)]:flex-col [@media(max-width:767px)]:items-stretch [@media(max-width:767px)]:gap-2">
            <div className="flex min-w-0 items-center gap-5 [@media(max-width:767px)]:gap-3">
              {/* WebKitで縮尺変更後の画像が乱れないよう、表示幅の境界で作り直します。 */}
              <Fragment key={mobile ? "mobile-board-preview" : "desktop-board-preview"}>
                {props.boardPreview}
              </Fragment>
              {props.game === "four-reversi" && (
                <div
                  aria-hidden="true"
                  data-testid="lobby-board-preview"
                  className="grid shrink-0 grid-cols-8 grid-rows-8 w-[88px] aspect-square gap-px p-[5px] border border-solid border-[#316a4d] rounded-lg bg-[#326a4e] shadow-[4px_7px_12px_#32694a22] -rotate-7 [@media(max-width:767px)]:w-[56px] [@media(max-width:767px)]:p-[3px]"
                >
                  {Array.from({ length: 64 }, (_, index) => (
                    <span
                      className="relative min-w-0 min-h-0 bg-[#4d976c] even:bg-[#529c71]"
                      key={index}
                    >
                      {previewStones[index] && (
                        <span
                          className={`absolute inset-[8%] rounded-full border border-solid border-[#00000018] shadow-[1px_2px_3px_#122d3150] ${previewStoneClasses[previewStones[index]!]}`}
                        />
                      )}
                    </span>
                  ))}
                </div>
              )}
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
                <AppIcon name="help" />
                遊び方
              </AppButton>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-5 [@media(max-width:767px)]:grid-cols-1 [@media(max-width:767px)]:gap-[18px]">
            {order.map((section) => sections[section])}
          </div>
          <footer className="mt-0 pt-[14px] pb-5 border-t border-solid border-lobby-footer-line text-muted text-xs text-center">
            TetraBoard
          </footer>
        </main>
      </div>
      {dialog?.type === "entry" && (
        <RoomEntryDialog
          intent={dialog.intent}
          theme={game.theme}
          threePlayerAttackProhibited={props.threePlayerAttackProhibited}
          selectedRoomId={dialog.roomId}
          name={props.name}
          roomCode={props.roomCode}
          mode={props.mode}
          busy={props.isSubmitting !== null}
          message={props.message}
          onNameChange={props.onNameChange}
          onRoomCodeChange={props.onRoomCodeChange}
          onModeChange={props.onModeChange}
          onThreePlayerAttackChange={props.onThreePlayerAttackChange}
          onSubmit={() => props.onSubmitRoom?.(dialog.intent, dialog.roomId)}
          onClose={closeDialog}
          registrationPath={game.homeTo}
          humanOnly={dialog.humanOnly}
        />
      )}
      {dialog?.type === "rules" && <HowToPlayDialog game={props.game} onClose={closeDialog} />}
    </div>
  );
}
