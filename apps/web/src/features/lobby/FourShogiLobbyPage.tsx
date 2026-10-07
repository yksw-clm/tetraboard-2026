import { getRoomContract } from "@tetraboard/protocol";
import { useNavigate, useNavigation } from "react-router";
import { LobbyView } from "./LobbyView";
import { LobbyList } from "./LobbyList";
import { LobbyRankings } from "./LobbyRankings";
import { FourShogiLobbyBoardPreview } from "./FourShogiLobbyBoardPreview";
import { useLobby } from "./useLobby";
import { useRoomEntry } from "./useRoomEntry";

export function FourShogiLobbyPage() {
  const navigate = useNavigate();
  const navigation = useNavigation();
  const lobby = useLobby("four-shogi");
  const entry = useRoomEntry("four-shogi");
  return (
    <LobbyView
      game="four-shogi"
      registrationDraft={entry.registrationDraft}
      boardPreview={<FourShogiLobbyBoardPreview />}
      name={entry.name}
      roomCode={entry.roomCode}
      mode={entry.mode}
      timeControl={entry.timeControl}
      threePlayerAttackProhibited={entry.threePlayerAttackProhibited}
      isSubmitting={entry.isSubmitting}
      message={entry.message}
      onNameChange={entry.setName}
      onRoomCodeChange={entry.setRoomCode}
      onModeChange={entry.setMode}
      onTimeControlChange={entry.setTimeControl}
      onThreePlayerAttackChange={entry.setThreePlayerAttackProhibited}
      onClearMessage={entry.clearMessage}
      onSubmitRoom={(intent, roomId) => void entry.submitRoom(intent, roomId)}
      renderRooms={(onJoin) => (
        <LobbyList
          rooms={lobby.rooms}
          nextCursor={lobby.nextCursor}
          error={lobby.error}
          loading={lobby.loading}
          isInitialLoading={lobby.isInitialLoading}
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
      rankings={<LobbyRankings game="four-shogi" theme="four-shogi" />}
    />
  );
}
