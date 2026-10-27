import { getRoomContract } from "@tetraboard/protocol";
import { useNavigate, useNavigation } from "react-router";
import { LobbyView } from "./LobbyView";
import { LobbyList } from "./LobbyList";
import { LobbyRankings } from "./LobbyRankings";
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
      name={entry.name}
      roomCode={entry.roomCode}
      mode={entry.mode}
      cpuLevel={entry.cpuLevel}
      onCpuLevelChange={entry.setCpuLevel}
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
      onSubmitRoom={(intent, roomId, instanceId) =>
        void entry.submitRoom(intent, roomId, instanceId)
      }
      renderRooms={(onJoin) => (
        <LobbyList
          {...lobby}
          rooms={lobby.rooms}
          error={lobby.error}
          loading={lobby.loading}
          isInitialLoading={lobby.isInitialLoading}
          pendingSource={lobby.pendingSource}
          pendingWatchRoomId={
            navigation.state === "loading"
              ? navigation.location?.pathname.match(/^\/rooms\/(\d{5})$/)?.[1]
              : undefined
          }
          onRefresh={() => void lobby.refresh("refresh")}
          onJoin={onJoin}
          onWatch={(roomId, instanceId) =>
            void navigate(`${getRoomContract.pathFor(roomId)}?invite=${instanceId}&watch=1`)
          }
        />
      )}
      rankings={<LobbyRankings game="four-shogi" theme="four-shogi" />}
    />
  );
}
