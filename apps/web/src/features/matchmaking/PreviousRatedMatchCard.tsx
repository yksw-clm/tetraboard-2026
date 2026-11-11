import type { MatchmakingState } from "@tetraboard/protocol";
import { gameCatalog } from "@tetraboard/protocol/games";
import { AppButton, AppButtonLink } from "../../shared/ui/AppButton";
import { AppCard } from "../../shared/ui/AppCard";
import { LobbyBoardPreview } from "../lobby/LobbyBoardPreview";

export function PreviousRatedMatchCard({
  previous,
  refresh,
}: {
  previous: NonNullable<MatchmakingState["previousMatch"]>;
  refresh: () => void;
}) {
  const room = previous.room;
  const playing = previous.phase === "playing";
  return (
    <AppCard className="gap-3">
      <div className="flex items-center gap-3">
        <LobbyBoardPreview game={previous.game} compact className="!w-11 !rotate-0 !shadow-none" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-muted">
            {gameCatalog[previous.game].name}のレート戦
          </p>
          <h3 className="text-base font-bold wrap-anywhere">
            {room
              ? room.matchSequence === undefined
                ? "レート戦"
                : `レート戦 #${room.matchSequence}`
              : "前局のルーム"}
          </h3>
        </div>
        {room && (
          <span className="rounded-full bg-surface-hover px-2 py-1 text-xs font-bold text-muted tabular-nums">
            #{room.id}
          </span>
        )}
      </div>
      <p role="status" className="text-sm font-bold text-muted">
        {playing
          ? "前局は対局中です"
          : previous.phase === "matched"
            ? "開始待ちの対局があります"
            : previous.phase === "saving"
              ? "前局の結果を保存しています"
              : "前局の状況を確認できません"}
      </p>
      <p className="text-sm leading-relaxed text-muted">
        前局が終了し、レート結果が保存されるまで、すべてのゲームで次のレート戦を探せません。
      </p>
      {room && (
        <p className="text-sm">
          人間{room.humanCount}人・CPU{room.cpuCount}人
        </p>
      )}
      {playing && room ? (
        <AppButtonLink to={`/rooms/${room.id}?invite=${room.instanceId}&watch=1`}>
          観戦する
        </AppButtonLink>
      ) : previous.phase === "matched" ? (
        <AppButtonLink to={`${gameCatalog[previous.game].lobbyPath}?matchmaking=1`}>
          対局に戻る
        </AppButtonLink>
      ) : previous.phase === "unavailable" ? (
        <AppButton appearance="secondary" onPress={refresh}>
          状態を確認する
        </AppButton>
      ) : null}
    </AppCard>
  );
}
