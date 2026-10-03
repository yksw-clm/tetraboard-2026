import { sides, type Side } from "@tetraboard/four-shogi";
import { type FourShogiLastRound } from "@tetraboard/protocol";
import { shogiEliminationLabels, shogiSideNames } from "./fourShogiRoomPresentation";

const endReasonNames = {
  last_player: "最後の1人になったため",
  no_survivors: "全員が脱落したため",
  repetition: "千日手のため",
  agreement: "全員の合意による引き分け",
  team_eliminated: "チームのプレイヤーが脱落したため",
  simultaneous_mate: "両チームが同時に詰んだため",
} as const;
const teamNames = { "south-north": "南・北チーム", "west-east": "西・東チーム" } as const;

export function FourShogiGameResultView({ lastRound }: { lastRound: FourShogiLastRound }) {
  const { result } = lastRound.game;
  const name = (side: Side) =>
    lastRound.players.find((player) => player.side === side)?.name ?? shogiSideNames[side];
  const elimination = (side: Side) =>
    lastRound.game.eliminations.find((entry) => entry.side === side);
  return (
    <section
      className="[&_ul]:list-none [&_ul]:p-0 [&_ul]:mt-[14px] [&_li]:py-[10px] [&_li]:border-b [&_li]:border-solid [&_li]:border-line [&_p]:text-muted [&_p]:text-[13px]"
      aria-label="対局結果の詳細"
    >
      <p>終局理由：{endReasonNames[result.reason]}</p>
      {result.mode === "singles" ? (
        <ul>
          {result.standings.map((standing) => {
            const eliminated = elimination(standing.side);
            return (
              <li key={standing.side}>
                {standing.rank}位：{name(standing.side)}（{shogiSideNames[standing.side]}）
                {eliminated ? ` ${shogiEliminationLabels[eliminated.reason]}` : ""}
              </li>
            );
          })}
        </ul>
      ) : (
        <>
          <p>勝敗：{result.winner === null ? "引き分け" : `${teamNames[result.winner]}の勝ち`}</p>
          <ul>
            {sides.map((side) => {
              const eliminated = elimination(side);
              return (
                <li key={side}>
                  {name(side)}（{shogiSideNames[side]}）
                  {eliminated ? ` ${shogiEliminationLabels[eliminated.reason]}` : ""}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
