import { getRoomContract } from "@tetraboard/protocol";
import { useNavigate, useNavigation } from "react-router";
import { LobbyView } from "./LobbyView";
import { LobbyList } from "./LobbyList";
import { LobbyRankings } from "./LobbyRankings";
import { useLobby } from "./useLobby";
import { useRoomEntry } from "./useRoomEntry";

export function FourReversiLobbyPage() {
  const navigate = useNavigate();
  const navigation = useNavigation();
  const lobby = useLobby();
  const entry = useRoomEntry();

  return (
    <LobbyView
      game="four-reversi"
      registrationDraft={entry.registrationDraft}
      name={entry.name}
      roomCode={entry.roomCode}
      mode={entry.mode}
      timeControl={entry.timeControl}
      isSubmitting={entry.isSubmitting}
      message={entry.message}
      renderRooms={(onJoin) => (
        <LobbyList
          rooms={lobby.rooms}
          nextCursor={lobby.nextCursor}
          error={lobby.error}
          loading={lobby.loading}
          moreLoading={lobby.moreLoading}
          pendingSource={lobby.pendingSource}
          pendingWatchRoomId={
            navigation.state === "loading"
              ? navigation.location?.pathname.match(/^\/rooms\/(\d{5})$/)?.[1]
              : undefined
          }
          onRefresh={() => void lobby.refresh("refresh")}
          onLoadMore={() => void lobby.loadMore()}
          onJoin={onJoin}
          onWatch={(roomId) => void navigate(getRoomContract.pathFor(roomId))}
        />
      )}
      rankings={<LobbyRankings />}
      onNameChange={entry.setName}
      onRoomCodeChange={entry.setRoomCode}
      onModeChange={entry.setMode}
      onTimeControlChange={entry.setTimeControl}
      onClearMessage={entry.clearMessage}
      onSubmitRoom={(intent, roomId) => void entry.submitRoom(intent, roomId)}
    />
  );
}
