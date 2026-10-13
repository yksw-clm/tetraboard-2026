import { useState } from "react";
import { Link, useNavigate } from "react-router";
import type { LobbyRoom } from "@tetraboard/protocol/general-lobby";
import { AppHeader } from "../../shared/ui/AppHeader";
import { appPageWidthClasses } from "../../shared/ui/pageLayout";
import { AccountMenu } from "../account/AccountMenu";
import { useAccount } from "../account/useAccount";
import { LobbyFooter } from "./LobbyFooter";
import { GeneralLobbyGameNavigation } from "./GeneralLobbyGameNavigation";
import { GeneralLobbyRooms } from "./GeneralLobbyRooms";
import { GeneralLobbyChat } from "./GeneralLobbyChat";
import { useGeneralLobbyRooms } from "./useGeneralLobbyRooms";
import { useRoomEntry } from "./useRoomEntry";
import { RoomEntryDialog } from "./RoomEntryDialog";
import { RecentMatches } from "../matches/RecentMatches";
import { gameThemes } from "../../shared/ui/appTheme";
export function GeneralLobbyPage() {
  const rooms = useGeneralLobbyRooms(),
    account = useAccount(),
    navigate = useNavigate();
  const [selected, setSelected] = useState<LobbyRoom | null>(null);
  const entry = useRoomEntry(selected?.game);
  function roomAction(room: LobbyRoom, intent: "join" | "watch") {
    if (intent === "watch") {
      void navigate(`/rooms/${room.id}?invite=${room.instanceId}&watch=1`);
      return;
    }
    entry.clearMessage();
    setSelected(room);
  }
  return (
    <div className="app-theme min-h-dvh text-[15px] leading-[1.6] text-ink">
      <AppHeader homeTo="/" homeLabel="TetraBoard 総合ロビー">
        <AccountMenu />
      </AppHeader>
      <div className="lobby-background">
        <GeneralLobbyGameNavigation />
        <main
          className={`${appPageWidthClasses} mx-auto flex flex-col gap-[22px] px-6 py-6 [@media(max-width:767px)]:px-4`}
        >
          <div className="flex items-center gap-4">
            <span
              aria-hidden="true"
              className="grid size-14 shrink-0 place-items-center rounded-panel border border-solid border-line bg-white shadow-panel [@media(max-width:767px)]:size-11"
            >
              <img
                src="/favicon.ico"
                width="42"
                height="42"
                alt=""
                className="block [@media(max-width:767px)]:size-8"
              />
            </span>
            <h1 className="text-[36px] leading-[1.35] tracking-[0.02em] [@media(max-width:767px)]:text-[27px]">
              総合ロビー
            </h1>
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-stretch gap-x-5 [@media(min-width:768px)]:grid-rows-[auto_720px_auto] [@media(max-width:767px)]:grid-cols-1 [@media(max-width:767px)]:gap-y-[22px]">
            <GeneralLobbyRooms page={rooms} onRoomAction={roomAction} />
            <GeneralLobbyChat />
          </div>
          <RecentMatches game="all" />
          <LobbyFooter>
            <Link to="/feedback" className="inline-flex min-h-11 items-center text-brand underline">
              不具合・ご意見
            </Link>
          </LobbyFooter>
        </main>
      </div>
      {selected && (
        <RoomEntryDialog
          game={selected.game}
          theme={gameThemes[selected.game]}
          intent="join"
          selectedRoomId={selected.id}
          {...entry}
          busy={entry.isSubmitting !== null}
          unavailable={account.loading || Boolean(account.error)}
          onNameChange={entry.setName}
          onRoomCodeChange={entry.setRoomCode}
          onModeChange={entry.setMode}
          onCpuLevelChange={entry.setCpuLevel}
          onTimeControlChange={entry.setTimeControl}
          onClose={() => setSelected(null)}
          onSubmit={() => void entry.submitRoom("join", selected.id, selected.instanceId)}
        />
      )}
    </div>
  );
}
