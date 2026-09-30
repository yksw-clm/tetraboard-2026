import { type LastRound } from "@tetraboard/protocol";
import { type Color } from "@tetraboard/four-reversi";
import { colorNames } from "./roomPresentation";

const endReasonNames = {
  board_full: "盤面が埋まったため",
  all_passed: "全員が連続して自動パスしたため",
  last_player: "最後の1人になったため",
  team_eliminated: "チームのプレイヤーが脱落したため",
} as const;
const teamNames = { "black-red": "黒・赤チーム", "white-blue": "白・青チーム" } as const;

export function GameResultView({ lastRound }: { lastRound: LastRound }) {
  const { result } = lastRound.game;
  const playerName = (color: Color) =>
    lastRound.players.find((player) => player.color === color)?.name ?? colorNames[color];

  return (
    <section aria-label="対局結果">
      <h2>対局結果</h2>
      <p>終局理由：{endReasonNames[result.reason]}</p>
      {result.mode === "singles" ? (
        <ul>
          {result.standings.map((standing) => (
            <li key={standing.color}>
              {standing.rank}位：{playerName(standing.color)}（{colorNames[standing.color]}）
              {standing.stoneCount === undefined ? " 脱落" : ` ${standing.stoneCount}石`}
            </li>
          ))}
        </ul>
      ) : (
        <>
          <p>勝敗：{result.winner === null ? "引き分け" : `${teamNames[result.winner]}の勝ち`}</p>
          {result.teamTotals !== null && (
            <p>
              黒・赤チーム {result.teamTotals["black-red"]}石、白・青チーム{" "}
              {result.teamTotals["white-blue"]}石
            </p>
          )}
          <ul>
            {result.stoneCounts.map(({ color, count }) => (
              <li key={color}>
                {playerName(color)}（{colorNames[color]}） {count}石
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
