import type { ShogiRoom } from "@tetraboard/protocol";
import { ShogiRoomView } from "./ShogiRoomView";
import { useShogiRoomSession } from "./useShogiRoomSession";
import { useSessionChat } from "./useSessionChat";
export default function ShogiRoomDetail({
  invited,
  ...options
}: Parameters<typeof useShogiRoomSession>[0] & {
  invited: boolean;
  initialRoom: ShogiRoom;
}) {
  const session = useShogiRoomSession(options);
  const chat = useSessionChat(session);
  return <ShogiRoomView session={session} chat={chat} invited={invited} />;
}
