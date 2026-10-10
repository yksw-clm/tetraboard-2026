import { resultPlayer } from "./gameResultPresentation";
import { type Side } from "@tetraboard/four-shogi";
import type { FourShogiLastRound, Room } from "@tetraboard/protocol";
import { shogiSideNames } from "./fourShogiRoomPresentation";
import { ShogiSideBadge } from "./FourShogiPlayerCard";
import { GameResultList, GameResultRow, GameResultTeam, ResultParticipant } from "./GameResultRow";
import { shogiKnockoutTargets } from "./shogiKnockoutTargets";
import type { FourShogiReplayFrame } from "./fourShogiReplay";
import { AppButton } from "../../shared/ui/AppButton";

const endReasonNames = {
  last_player: "最後の1人になったため",
  no_survivors: "全員が脱落したため",
  repetition: "千日手のため",
  agreement: "全員の合意による引き分け",
  team_eliminated: "チームのプレイヤーが脱落したため",
  simultaneous_mate: "両チームが同時に詰んだため",
} as const;
const teamNames = { "south-north": "南・北チーム", "west-east": "西・東チーム" } as const;

const teamSides = { "south-north": ["south", "north"], "west-east": ["west", "east"] } as const;

export function FourShogiGameResultView({
  lastRound,
  currentPlayers,
  replay,
}: {
  lastRound: FourShogiLastRound;
  currentPlayers?: Room["players"];
  replay: {
    frames: FourShogiReplayFrame[];
    loading: boolean;
    error: string | null;
    retry?: () => void;
  };
}) {
  const { result } = lastRound.game;
  const targets = shogiKnockoutTargets(replay.frames);
  const player = (side: Side) =>
    resultPlayer(
      lastRound.players.find((entry) => entry.side === side) ?? {
        id: side,
        name: shogiSideNames[side],
      },
      currentPlayers,
    );
  const row = (side: Side, rank?: number) => (
    <GameResultRow
      key={side}
      player={player(side)}
      rank={rank}
      details={<ShogiSideBadge side={side} proposed={false} />}
      right={
        <div className="flex flex-col gap-2">
          {replay.error ? (
            <>
              <span role="alert">撃破情報を取得できませんでした。</span>
              {replay.retry && (
                <AppButton size="compact" appearance="secondary" onPress={replay.retry}>
                  再試行
                </AppButton>
              )}
            </>
          ) : replay.loading ? (
            <span role="status">読み込み中…</span>
          ) : targets[side].length === 0 ? (
            "なし"
          ) : (
            targets[side].map((target) => (
              <ResultParticipant key={target} player={player(target)} />
            ))
          )}
        </div>
      }
    />
  );
  return (
    <section aria-label="対局結果の詳細">
      <p className="text-[13px] text-muted">終局理由：{endReasonNames[result.reason]}</p>
      {result.mode === "singles" ? (
        <GameResultList rightHeading="撃破">
          {result.standings.map((standing) => row(standing.side, standing.rank))}
        </GameResultList>
      ) : (
        (result.winner === "west-east"
          ? (["west-east", "south-north"] as const)
          : (["south-north", "west-east"] as const)
        ).map((team) => (
          <GameResultTeam
            key={team}
            name={teamNames[team]}
            outcome={result.winner === null ? "引き分け" : result.winner === team ? "勝利" : "敗北"}
            rightHeading="撃破"
          >
            {teamSides[team].map((side) => row(side))}
          </GameResultTeam>
        ))
      )}
    </section>
  );
}
