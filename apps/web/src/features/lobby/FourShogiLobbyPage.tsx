import { getRoomContract } from "@tetraboard/protocol";
import { useNavigate } from "react-router";
import { LobbyView } from "./LobbyView";
import { LobbyList } from "./LobbyList";
import { LobbyRankings } from "./LobbyRankings";
import { useLobby } from "./useLobby";
import { useRoomEntry } from "./useRoomEntry";

export function FourShogiLobbyPage() {
  const navigate = useNavigate();
  const lobby = useLobby("four-shogi");
  const entry = useRoomEntry("four-shogi");
  return (
    <LobbyView
      game="four-shogi"
      name={entry.name}
      roomCode={entry.roomCode}
      mode={entry.mode}
      threePlayerAttackProhibited={entry.threePlayerAttackProhibited}
      isSubmitting={entry.isSubmitting}
      message={entry.message}
      onNameChange={entry.setName}
      onRoomCodeChange={entry.setRoomCode}
      onModeChange={entry.setMode}
      onThreePlayerAttackChange={entry.setThreePlayerAttackProhibited}
      onClearMessage={entry.clearMessage}
      onSubmitRoom={(intent, roomId) => void entry.submitRoom(intent, roomId)}
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
      rankings={<LobbyRankings unavailable theme="four-shogi" />}
    />
  );
}
