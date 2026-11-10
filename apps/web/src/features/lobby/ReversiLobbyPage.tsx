import { getRoomContract } from "@tetraboard/protocol";
import { useNavigate, useNavigation, useSearchParams } from "react-router";
import { LobbyView } from "./LobbyView";
import { LobbyList } from "./LobbyList";
import { LobbyRankings } from "./LobbyRankings";
import { useLobby } from "./useLobby";
import { RatedMatchmakingDialog } from "../matchmaking/RatedMatchmakingDialog";
import { useReversiRatedAvailability } from "../matchmaking/useReversiRatedAvailability";
import { useRoomEntry } from "./useRoomEntry";

export function ReversiLobbyPage() {
  const navigate = useNavigate();
  const navigation = useNavigation();
  const [search] = useSearchParams();
  const ratedAvailable = useReversiRatedAvailability(true);
  const lobby = useLobby("reversi");
  const entry = useRoomEntry("reversi");

  return (
    <>
      <LobbyView
        game="reversi"
        showRatedMatchmaking={ratedAvailable}
        registrationDraft={entry.registrationDraft}
        name={entry.name}
        roomCode={entry.roomCode}
        mode={entry.mode}
        cpuLevel={entry.cpuLevel}
        onCpuLevelChange={entry.setCpuLevel}
        timeControl={entry.timeControl}
        isSubmitting={entry.isSubmitting}
        message={entry.message}
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
        rankings={<LobbyRankings game="reversi" theme="reversi" />}
        onNameChange={entry.setName}
        onRoomCodeChange={entry.setRoomCode}
        onModeChange={entry.setMode}
        onTimeControlChange={entry.setTimeControl}
        onClearMessage={entry.clearMessage}
        onSubmitRoom={(intent, roomId, instanceId, avatarPresetId) =>
          void entry.submitRoom(intent, roomId, instanceId, avatarPresetId)
        }
      />
      {search.get("matchmaking") === "1" && <RatedMatchmakingDialog game="reversi" />}
    </>
  );
}
