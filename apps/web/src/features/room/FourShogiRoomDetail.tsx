import type { FourShogiRoom } from "@tetraboard/protocol";
import { FourShogiRoomView } from "./FourShogiRoomView";
import { useFourShogiRoomSession } from "./useFourShogiRoomSession";
import { useSessionChat } from "./useSessionChat";
export default function FourShogiRoomDetail({
  invited,
  ...options
}: Parameters<typeof useFourShogiRoomSession>[0] & {
  invited: boolean;
  initialRoom: FourShogiRoom;
}) {
  const session = useFourShogiRoomSession(options);
  const chat = useSessionChat(session);
  return <FourShogiRoomView session={session} chat={chat} invited={invited} />;
}
