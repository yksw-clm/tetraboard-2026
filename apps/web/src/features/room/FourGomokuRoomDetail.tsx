import type { FourGomokuRoom } from "@tetraboard/protocol";
import type { RoomLoaderData } from "./roomLoader";
import { FourGomokuRoomView } from "./FourGomokuRoomView";
import { useFourGomokuSession } from "./useFourGomokuSession";
import { useSessionChat } from "./useSessionChat";
export default function RoomDetail({
  initialRoom,
  initialMembership,
  initialServerNowMs,
  initialPresence,
  initialStampsSupported,
  invited,
}: {
  initialRoom: FourGomokuRoom;
  initialMembership: RoomLoaderData["membership"];
  invited: boolean;
  initialServerNowMs: number;
  initialPresence: RoomLoaderData["presence"];
  initialStampsSupported?: boolean;
}) {
  const session = useFourGomokuSession({
    initialRoom,
    initialMembership,
    initialServerNowMs,
    initialPresence,
    initialStampsSupported,
  });
  const chat = useSessionChat(session);
  return <FourGomokuRoomView session={session} chat={chat} invited={invited} />;
}
