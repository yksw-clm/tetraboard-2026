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
  invited,
}: {
  initialRoom: ReversiRoom;
  initialMembership: RoomLoaderData["membership"];
  invited: boolean;
  initialServerNowMs: number;
  initialPresence: RoomLoaderData["presence"];
}) {
  const session = useReversiSession({
    initialRoom,
    initialMembership,
    initialServerNowMs,
    initialPresence,
  });
  const chat = useSessionChat(session);
  return <ReversiRoomView session={session} chat={chat} invited={invited} />;
}
