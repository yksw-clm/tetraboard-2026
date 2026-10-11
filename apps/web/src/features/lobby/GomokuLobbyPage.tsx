import { createInitialState } from "@tetraboard/gomoku";
import { GomokuBoard } from "../room/GomokuBoard";
import { getRoomContract } from "@tetraboard/protocol";
import { useNavigate, useNavigation } from "react-router";
import { LobbyView } from "./LobbyView";
import { LobbyList } from "./LobbyList";
import { LobbyRankings } from "./LobbyRankings";
import { useLobby } from "./useLobby";
import { useRoomEntry } from "./useRoomEntry";

export function GomokuLobbyPage() {
  const navigate = useNavigate();
  const navigation = useNavigation();
  const lobby = useLobby("gomoku");
  const entry = useRoomEntry("gomoku");

  return (
    <LobbyView
      boardPreview={
        <div aria-hidden="true" className="pointer-events-none w-14 shrink-0 -rotate-6 md:w-[88px]">
          <GomokuBoard game={createInitialState()} canPlay={false} onPlaceStone={() => {}} />
        </div>
      }
      game="gomoku"
      forbiddenRules={entry.forbiddenRules}
      onForbiddenRulesChange={entry.setForbiddenRules}
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
      rankings={<LobbyRankings game="gomoku" theme="gomoku" />}
      onNameChange={entry.setName}
      onRoomCodeChange={entry.setRoomCode}
      onModeChange={entry.setMode}
      onTimeControlChange={entry.setTimeControl}
      onClearMessage={entry.clearMessage}
      onSubmitRoom={(intent, roomId) => void entry.submitRoom(intent, roomId)}
    />
  );
}
