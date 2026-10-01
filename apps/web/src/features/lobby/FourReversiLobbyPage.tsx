import { getRoomContract } from "@tetraboard/protocol";
import { useNavigate } from "react-router";
import { FourReversiLobbyView } from "./FourReversiLobbyView";
import { useLobby } from "./useLobby";
import { useRoomEntry } from "./useRoomEntry";

export function FourReversiLobbyPage() {
  const navigate = useNavigate();
  const lobby = useLobby();
  const entry = useRoomEntry();

  return (
    <FourReversiLobbyView
      name={entry.name}
      roomCode={entry.roomCode}
      mode={entry.mode}
      isSubmitting={entry.isSubmitting}
      message={entry.message}
      lobbyRooms={lobby.rooms}
      lobbyNextCursor={lobby.nextCursor}
      lobbyError={lobby.error}
      lobbyLoading={lobby.loading}
      lobbyMoreLoading={lobby.moreLoading}
      onNameChange={entry.setName}
      onRoomCodeChange={entry.setRoomCode}
      onModeChange={entry.setMode}
      onClearMessage={entry.clearMessage}
      onSubmitRoom={(intent, roomId) => void entry.submitRoom(intent, roomId)}
      onWatchRoom={(roomId) => void navigate(getRoomContract.pathFor(roomId))}
      onLobbyRefresh={() => void lobby.refresh()}
      onLobbyLoadMore={() => void lobby.loadMore()}
    />
  );
}
