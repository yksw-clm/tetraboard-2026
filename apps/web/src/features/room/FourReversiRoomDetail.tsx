import type { FourReversiRoom } from "@tetraboard/protocol";
import type { RoomLoaderData } from "./roomLoader";
import { RoomView } from "./RoomView";
import { useRoomSession } from "./useRoomSession";
import { useSessionChat } from "./useSessionChat";
export default function RoomDetail({
  initialRoom,
  initialMembership,
  initialServerNowMs,
  initialPresence,
  invited,
}: {
  initialRoom: FourReversiRoom;
  initialMembership: RoomLoaderData["membership"];
  invited: boolean;
  initialServerNowMs: number;
  initialPresence: RoomLoaderData["presence"];
}) {
  const session = useRoomSession({
    initialRoom,
    initialMembership,
    initialServerNowMs,
    initialPresence,
  });
  const chat = useSessionChat(session);
  return <RoomView session={session} chat={chat} invited={invited} />;
}
