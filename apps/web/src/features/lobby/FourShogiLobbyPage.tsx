import { useState } from "react";
import { type RoomMode } from "@tetraboard/protocol";
import { AppCard } from "../../shared/ui/AppCard";
import { AppIcon } from "../../shared/ui/AppIcon";
import { AppSectionHeading } from "../../shared/ui/AppSectionHeading";
import { LobbyView } from "./LobbyView";
import { LobbyRankings } from "./LobbyRankings";

function ShogiRoomsPlaceholder() {
  return (
    <section
      aria-labelledby="public-rooms-title"
      className="min-w-0 [@media(min-width:768px)]:col-span-2"
    >
      <AppSectionHeading
        id="public-rooms-title"
        title="公開ルーム"
        description="四人将棋のオンライン対局は準備中です。"
      />
      <AppCard className="min-h-[180px] items-center justify-center gap-3 border-dashed p-5 text-center shadow-none">
        <span className="grid size-11 place-items-center rounded-control bg-surface-muted text-brand">
          <AppIcon name="users" />
        </span>
        <h3 className="text-base">四人将棋は準備中です</h3>
        <p className="text-sm text-muted">
          オンライン対局は準備中です。遊び方を見ながら、公開をお待ちください。
        </p>
      </AppCard>
    </section>
  );
}

export function FourShogiLobbyPage() {
  const [name, setName] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [mode, setMode] = useState<RoomMode>("singles");

  return (
    <LobbyView
      game="four-shogi"
      name={name}
      roomCode={roomCode}
      mode={mode}
      isSubmitting={null}
      message={null}
      onNameChange={setName}
      onRoomCodeChange={setRoomCode}
      onModeChange={setMode}
      onClearMessage={() => {}}
      renderRooms={() => <ShogiRoomsPlaceholder />}
      rankings={<LobbyRankings unavailable theme="four-shogi" />}
    />
  );
}
