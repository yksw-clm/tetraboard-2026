import { useState } from "react";
import type { AccountProfile, CpuLevel, Room, RoomMembership } from "@tetraboard/protocol";

export function useCpuAddition({
  room,
  membership,
  hostPlayerId,
  canManageSettings,
  account,
  addCpu,
}: {
  room: Room;
  membership: RoomMembership | null;
  hostPlayerId: string | null;
  canManageSettings: boolean;
  account: { user: AccountProfile | null; loading: boolean; error: string | null };
  addCpu: (level: CpuLevel) => void;
}) {
  const [confirmation, setConfirmation] = useState<CpuLevel | null>(null);
  const canAdd =
    canManageSettings &&
    hostPlayerId === membership?.playerId &&
    room.players.length < 4 &&
    !account.loading &&
    !account.error;
  if (confirmation !== null && (!canAdd || !account.user)) setConfirmation(null);
  return {
    canAdd,
    confirmation,
    cancel: () => setConfirmation(null),
    request(level: CpuLevel) {
      if (!canAdd) return;
      if (account.user && !room.players.some((player) => player.kind === "cpu"))
        setConfirmation(level);
      else addCpu(level);
    },
    confirm() {
      if (!canAdd || confirmation === null) return;
      addCpu(confirmation);
      setConfirmation(null);
    },
  };
}
