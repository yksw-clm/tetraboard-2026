import { AppActionCard } from "../../shared/ui/AppActionCard";
import { AppSectionHeading } from "../../shared/ui/AppSectionHeading";
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
import { AppHeader } from "../../shared/ui/AppHeader";
import { fourReversiLobbyPath } from "../../app/paths";
import { HowToPlayDialog } from "./HowToPlayDialog";
import { AppIcon } from "../../shared/ui/AppIcon";
import { LobbyList } from "./LobbyList";
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
      <AppHeader homeTo={fourReversiLobbyPath} homeLabel="TetraBoard 四人リバーシのロビー" />
      <main className="flex flex-col gap-[22px] max-w-[1148px] mx-auto px-6 pt-6 [@media(max-width:650px)]:gap-[18px] [@media(max-width:650px)]:px-5 [@media(max-width:650px)]:pt-5">
        <div className="flex items-center justify-between gap-5 [&_h1]:text-[36px] [&_h1]:leading-[1.35] [&_h1]:tracking-[0.02em] [@media(max-width:650px)]:grid [@media(max-width:650px)]:grid-cols-[minmax(0,1fr)_auto] [@media(max-width:650px)]:gap-x-2 [@media(max-width:650px)]:gap-y-0 [@media(max-width:650px)]:[&>div]:contents [@media(max-width:650px)]:[&_h1]:text-[27px] [@media(max-width:650px)]:[&>button]:col-start-2 [@media(max-width:650px)]:[&>button]:row-start-1 [@media(max-width:650px)]:[&>button]:px-[3px] [@media(max-width:650px)]:[&>button]:gap-[5px] [@media(max-width:650px)]:[&_svg]:size-[17px]">
          <div>
            <h1>四人リバーシ</h1>
            <p className="mt-[6px]! text-muted text-sm [@media(max-width:650px)]:col-span-full [@media(max-width:650px)]:row-start-2 [@media(max-width:650px)]:text-xs">
              ひとりでも、友達とでも。4色で楽しむリバーシ。
            </p>
          </div>
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

        <section aria-label="すぐ遊ぶ">
          <AppCard className="lobby-quick-background flex flex-row items-center justify-between gap-8 px-12 py-5 border-[#d2e6d9] rounded-[22px] shadow-[0_8px_28px_#2c653d06] [@media(650px<width<=900px)]:px-[30px] [@media(650px<width<=900px)]:py-[18px] [@media(max-width:900px)]:gap-5 [@media(max-width:650px)]:block [@media(max-width:650px)]:px-[26px] [@media(max-width:650px)]:py-5 [@media(max-width:650px)]:rounded-[18px]">
            <AppCard.Content>
              <AppButton
                className="justify-between min-w-[210px] min-h-[52px] px-6 rounded-xl text-[17px] [@media(max-width:650px)]:w-full"
                type="button"
                onPress={() => openEntry("quick")}
              >
                すぐ遊ぶ
                <AppIcon name="arrow" />
              </AppButton>
              <p className="mt-[6px]! text-[#526d5e] text-xs">CPU3人と対戦</p>
            </AppCard.Content>
            <div
              className="flex flex-col items-center shrink-0 gap-3 py-1 px-[18px] [@media(max-width:900px)]:px-[5px] [@media(max-width:650px)]:hidden"
              aria-hidden="true"
            >
              <div className="grid grid-cols-8 grid-rows-8 w-[170px] aspect-square gap-px p-[9px] border border-solid border-[#316a4d] rounded-xl bg-[#326a4e] shadow-[8px_14px_24px_#32694a22] -rotate-7">
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
              <span className="text-[#60836e] text-[11px] tracking-[0.08em]">
                黒 → 白 → 赤 → 青
              </span>
            </div>
          </AppCard>
        </section>

        <section aria-labelledby="friends-title">
          <AppSectionHeading
            id="friends-title"
            title="友達と遊ぶ"
            description="ルームを作って招待するか、番号で合流しましょう。"
          />
          <div className="grid grid-cols-2 gap-4 [@media(max-width:650px)]:grid-cols-1 [@media(max-width:650px)]:gap-[10px]">
            <AppActionCard
              title="ルームを作る"
              description="友達を招待して、一緒に対戦"
              icon="plus"
              onPress={() => openEntry("create")}
            />
            <AppActionCard
              title="ルーム番号で参加"
              description="5桁の番号を入力して合流"
              icon="join"
              onPress={() => openEntry("join")}
            />
          </div>
        </section>

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
