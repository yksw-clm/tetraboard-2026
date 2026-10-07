import { resultPlayer } from "./gameResultPresentation";
import type { LastRound, Room } from "@tetraboard/protocol";
import { type Color } from "@tetraboard/four-reversi";
import { colorNames } from "./roomPresentation";
import { PlayerStoneCount } from "./PlayerStoneCount";
import { GameResultList, GameResultRow, GameResultTeam } from "./GameResultRow";

const endReasonNames = {
  board_full: "盤面が埋まったため",
  all_passed: "全員が連続して自動パスしたため",
  last_player: "最後の1人になったため",
  team_eliminated: "チームのプレイヤーが脱落したため",
} as const;
const teamNames = { "black-red": "黒・赤チーム", "white-blue": "白・青チーム" } as const;

const teamColors = { "black-red": ["black", "red"], "white-blue": ["white", "blue"] } as const;

export function GameResultView({
  lastRound,
  currentPlayers,
}: {
  lastRound: LastRound;
  currentPlayers?: Room["players"];
}) {
  const { result } = lastRound.game;
  const row = (color: Color, count: number | null, rank?: number) => {
    const player = resultPlayer(
      lastRound.players.find((entry) => entry.color === color) ?? {
        id: color,
        name: colorNames[color],
      },
      currentPlayers,
    );
    return (
      <GameResultRow
        key={color}
        player={player}
        rank={rank}
        details={
          <span className="inline-flex w-14 items-center gap-2">
            <PlayerStoneCount color={color} count={count} />
            {count === null && <span className="text-xs text-muted">脱落</span>}
          </span>
        }
      />
    );
  };
  return (
    <section aria-label="対局結果の詳細">
      <p className="text-[13px] text-muted">終局理由：{endReasonNames[result.reason]}</p>
      {result.mode === "singles" ? (
        <GameResultList>
          {result.standings.map((standing) =>
            row(standing.color, standing.stoneCount ?? null, standing.rank),
          )}
        </GameResultList>
      ) : (
        <>
          {result.teamTotals !== null && (
            <p className="text-[13px] text-muted">
              黒・赤チーム {result.teamTotals["black-red"]}石、白・青チーム{" "}
              {result.teamTotals["white-blue"]}石
            </p>
          )}
          {(result.winner === "white-blue"
            ? (["white-blue", "black-red"] as const)
            : (["black-red", "white-blue"] as const)
          ).map((team) => (
            <GameResultTeam
              key={team}
              name={teamNames[team]}
              outcome={
                result.winner === null ? "引き分け" : result.winner === team ? "勝利" : "敗北"
              }
            >
              {teamColors[team].map((color) =>
                row(
                  color,
                  result.stoneCounts.find((entry) => entry.color === color)?.count ?? null,
                ),
              )}
            </GameResultTeam>
          ))}
        </>
      )}
    </section>
  );
}
