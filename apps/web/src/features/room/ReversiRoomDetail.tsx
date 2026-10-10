import type { ReversiRoom } from "@tetraboard/protocol";
import type { RoomLoaderData } from "./roomLoader";
import { ReversiRoomView } from "./ReversiRoomView";
import { useReversiSession } from "./useReversiSession";
import { useSessionChat } from "./useSessionChat";
export default function RoomDetail({
  initialRoom,
  initialMembership,
  initialServerNowMs,
  initialPresence,
  initialStampsSupported,
  invited,
}: {
  initialRoom: ReversiRoom;
  initialMembership: RoomLoaderData["membership"];
  invited: boolean;
  initialServerNowMs: number;
  initialPresence: RoomLoaderData["presence"];
  initialStampsSupported?: boolean;
}) {
  const session = useReversiSession({
    initialRoom,
    initialMembership,
    initialServerNowMs,
    initialPresence,
    initialStampsSupported,
  });
  const chat = useSessionChat(session);
  return <ReversiRoomView session={session} chat={chat} invited={invited} />;
}
