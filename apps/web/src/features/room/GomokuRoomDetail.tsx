import type { GomokuRoom } from "@tetraboard/protocol";
import type { RoomLoaderData } from "./roomLoader";
import { GomokuRoomView } from "./GomokuRoomView";
import { useGomokuSession } from "./useGomokuSession";
import { useSessionChat } from "./useSessionChat";
export default function RoomDetail({
  initialRoom,
  initialMembership,
  initialServerNowMs,
  initialPresence,
  initialStampsSupported,
  invited,
}: {
  initialRoom: GomokuRoom;
  initialMembership: RoomLoaderData["membership"];
  invited: boolean;
  initialServerNowMs: number;
  initialPresence: RoomLoaderData["presence"];
  initialStampsSupported?: boolean;
}) {
  const session = useGomokuSession({
    initialRoom,
    initialMembership,
    initialServerNowMs,
    initialPresence,
    initialStampsSupported,
  });
  const chat = useSessionChat(session);
  return <GomokuRoomView session={session} chat={chat} invited={invited} />;
}
