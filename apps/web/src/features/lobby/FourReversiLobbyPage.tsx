import { getRoomContract } from "@tetraboard/protocol";
import { useNavigate } from "react-router";
import { LobbyView } from "./LobbyView";
import { LobbyList } from "./LobbyList";
import { LobbyRankings } from "./LobbyRankings";
import { useLobby } from "./useLobby";
import { useRoomEntry } from "./useRoomEntry";

export function FourReversiLobbyPage() {
  const navigate = useNavigate();
  const lobby = useLobby();
  const entry = useRoomEntry();

  return (
    <LobbyView
      game="four-reversi"
      registrationDraft={entry.registrationDraft}
      name={entry.name}
      roomCode={entry.roomCode}
      mode={entry.mode}
      isSubmitting={entry.isSubmitting}
      message={entry.message}
      renderRooms={(onJoin) => (
        <LobbyList
          rooms={lobby.rooms}
          nextCursor={lobby.nextCursor}
          error={lobby.error}
          loading={lobby.loading}
          moreLoading={lobby.moreLoading}
          onRefresh={() => void lobby.refresh()}
          onLoadMore={() => void lobby.loadMore()}
          onJoin={onJoin}
          onWatch={(roomId) => void navigate(getRoomContract.pathFor(roomId))}
        />
      )}
      rankings={<LobbyRankings />}
      onNameChange={entry.setName}
      onRoomCodeChange={entry.setRoomCode}
      onModeChange={entry.setMode}
      onClearMessage={entry.clearMessage}
      onSubmitRoom={(intent, roomId) => void entry.submitRoom(intent, roomId)}
    />
  );
}
