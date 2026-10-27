import type { LobbyRoomCard } from "@tetraboard/protocol/general-lobby";
import type { useGeneralLobbyRooms } from "./useGeneralLobbyRooms";
import { LobbyList } from "./LobbyList";

export function GeneralLobbyRooms({
  page,
  onRoomAction,
  onCreate,
}: {
  page: ReturnType<typeof useGeneralLobbyRooms>;
  onRoomAction: (room: LobbyRoomCard, intent: "join" | "watch") => void;
  onCreate?: () => void;
}) {
  function action(roomId: string, instanceId: string | undefined, intent: "join" | "watch") {
    const room = page.rooms.find((room) => room.id === roomId && room.instanceId === instanceId);
    if (room) onRoomAction(room, intent);
  }
  return (
    <LobbyList
      {...page}
      isInitialLoading={!page.loaded}
      onCreate={onCreate}
      onRefresh={() => void page.refresh()}
      onJoin={(id, _humanOnly, instanceId) => action(id, instanceId, "join")}
      onWatch={(id, instanceId) => action(id, instanceId, "watch")}
    />
  );
}
