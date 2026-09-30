import { getRoomContract } from "@tetraboard/protocol";
import { useNavigate } from "react-router";
import { HomeView } from "./HomeView";
import { useApiStatus } from "./useApiStatus";
import { useLobby } from "./useLobby";
import { useRoomEntry } from "./useRoomEntry";

export function HomePage() {
  const navigate = useNavigate();
  const apiStatus = useApiStatus();
  const lobby = useLobby();
  const entry = useRoomEntry();

  return (
    <HomeView
      apiStatus={apiStatus}
      name={entry.name}
      roomCode={entry.roomCode}
      mode={entry.mode}
      isSubmitting={entry.isSubmitting}
      roomResponse={entry.roomResponse}
      responseStatus={entry.responseStatus}
      message={entry.message}
      lobbyRooms={lobby.rooms}
      lobbyNextCursor={lobby.nextCursor}
      lobbyError={lobby.error}
      lobbyLoading={lobby.loading}
      lobbyMoreLoading={lobby.moreLoading}
      onNameChange={entry.setName}
      onRoomCodeChange={entry.setRoomCode}
      onModeChange={entry.setMode}
      onSubmitRoom={(intent, roomId) => void entry.submitRoom(intent, roomId)}
      onWatchRoom={(roomId) => void navigate(getRoomContract.pathFor(roomId))}
      onLobbyRefresh={() => void lobby.refresh()}
      onLobbyLoadMore={() => void lobby.loadMore()}
    />
  );
}
