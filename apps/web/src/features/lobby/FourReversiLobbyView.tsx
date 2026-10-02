const previewStoneClasses = {
  black: "preview-stone-black",
  white: "preview-stone-white",
  red: "preview-stone-red",
  blue: "preview-stone-blue",
} as const;
import { AppCard } from "../../shared/ui/AppCard";
import { AppButton } from "../../shared/ui/AppButton";

import { type RoomMode, type RoomPublicMetadata } from "@tetraboard/protocol";
import { useState } from "react";
import { AccountMenu } from "../account/AccountMenu";
import { AppHeader } from "../../shared/ui/AppHeader";
import { fourReversiLobbyPath } from "../../app/paths";
import { HowToPlayDialog } from "./HowToPlayDialog";
import { AppIcon } from "../../shared/ui/AppIcon";
import { LobbyList } from "./LobbyList";
import { LobbyRankings } from "./LobbyRankings";
import { RoomEntryDialog } from "./RoomEntryDialog";
import { type RoomEntryIntent } from "./useRoomEntry";

type Props = {
  name: string;
  roomCode: string;
  mode: RoomMode;
  isSubmitting: RoomEntryIntent | null;
  message: string | null;
  lobbyRooms: RoomPublicMetadata[];
  lobbyNextCursor: string | null;
  lobbyError: string | null;
  lobbyLoading: boolean;
  lobbyMoreLoading: boolean;
  onNameChange: (value: string) => void;
  onRoomCodeChange: (value: string) => void;
  onModeChange: (mode: RoomMode) => void;
  onClearMessage: () => void;
  onSubmitRoom: (intent: RoomEntryIntent, roomId?: string) => void;
  onWatchRoom: (roomId: string) => void;
  onLobbyRefresh: () => void;
  onLobbyLoadMore: () => void;
};

type ActiveDialog =
  | { type: "entry"; intent: RoomEntryIntent; roomId?: string }
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

export function FourReversiLobbyView(props: Props) {
  const [dialog, setDialog] = useState<ActiveDialog>(null);

  function openEntry(intent: RoomEntryIntent, roomId?: string): void {
    props.onClearMessage();
    setDialog({ type: "entry", intent, roomId });
  }

  function closeDialog(): void {
    if (props.isSubmitting === null) setDialog(null);
  }

  return (
    <div className="app-theme lobby-background min-h-dvh text-ink text-[15px] leading-[1.6]">
      <AppHeader homeTo={fourReversiLobbyPath} homeLabel="TetraBoard 四人リバーシのロビー">
        <AccountMenu />
      </AppHeader>
      <main className="flex flex-col gap-[22px] max-w-[1148px] mx-auto px-6 pt-6 [@media(max-width:650px)]:gap-[18px] [@media(max-width:650px)]:px-5 [@media(max-width:650px)]:pt-5">
        <div className="flex items-center justify-between gap-5 [@media(max-width:767px)]:flex-col [@media(max-width:767px)]:items-stretch [@media(max-width:767px)]:gap-2">
          <div className="flex min-w-0 items-center gap-5 [@media(max-width:767px)]:gap-3">
            <div
              aria-hidden="true"
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
            <div className="min-w-0">
              <h1 className="text-[36px] leading-[1.35] tracking-[0.02em] [@media(max-width:767px)]:text-[27px]">
                四人リバーシ
              </h1>
              <p className="mt-[6px]! text-muted text-sm [@media(max-width:767px)]:hidden">
                ひとりでも、友達とでも。4色で楽しむリバーシ。
              </p>
            </div>
          </div>
          <div className="flex items-center justify-between gap-2">
            <p className="hidden text-muted text-xs [@media(max-width:767px)]:block">
              ひとりでも、友達とでも。
              <br />
              4色で楽しむリバーシ。
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
          <section aria-labelledby="play-title" className="min-w-0">
            <AppCard className="lobby-quick-background h-full gap-3 p-5 border-[#d2e6d9]">
              <h2 id="play-title" className="text-lg font-bold">
                一人で遊ぶ
              </h2>
              <AppButton
                className="w-full min-h-[52px] justify-between px-6 text-base"
                type="button"
                onPress={() => openEntry("quick")}
              >
                すぐ遊ぶ
                <AppIcon name="arrow" />
              </AppButton>
              <AppButton
                className="w-full min-h-[52px] justify-between px-6 text-base"
                appearance="secondary"
                type="button"
                onPress={() => openEntry("create")}
              >
                ルームを作る
                <AppIcon name="plus" />
              </AppButton>
              <AppButton
                className="w-full min-h-[52px] justify-between px-6 text-base"
                appearance="secondary"
                type="button"
                onPress={() => openEntry("join")}
              >
                ルーム番号で参加
                <AppIcon name="join" />
              </AppButton>
            </AppCard>
          </section>
          <LobbyRankings />
        </div>

        <LobbyList
          rooms={props.lobbyRooms}
          nextCursor={props.lobbyNextCursor}
          error={props.lobbyError}
          loading={props.lobbyLoading}
          moreLoading={props.lobbyMoreLoading}
          onRefresh={props.onLobbyRefresh}
          onLoadMore={props.onLobbyLoadMore}
          onJoin={(roomId) => openEntry("join", roomId)}
          onWatch={props.onWatchRoom}
        />
        <footer className="mt-0 pt-[14px] pb-5 border-t border-solid border-[#e0e8e2] text-muted text-xs text-center">
          TetraBoard
        </footer>
      </main>
      {dialog?.type === "entry" && (
        <RoomEntryDialog
          intent={dialog.intent}
          selectedRoomId={dialog.roomId}
          name={props.name}
          roomCode={props.roomCode}
          mode={props.mode}
          busy={props.isSubmitting !== null}
          message={props.message}
          onNameChange={props.onNameChange}
          onRoomCodeChange={props.onRoomCodeChange}
          onModeChange={props.onModeChange}
          onSubmit={() => props.onSubmitRoom(dialog.intent, dialog.roomId)}
          onClose={closeDialog}
        />
      )}
      {dialog?.type === "rules" && <HowToPlayDialog onClose={closeDialog} />}
    </div>
  );
}
