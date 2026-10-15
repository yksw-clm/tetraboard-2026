import { restoreAnalysisPosition, type AnalysisPosition } from "../src/analysis";
import { encodeAction } from "../src/actionEncoding";
import { applyAction, getLegalActions } from "../src/index";
import source from "../../../test-fixtures/matches/shogi-singles-ai-sole-win.json";

export async function modelTacticalPositions() {
  const rows = [];
  for (const restricted of [false, true]) {
    const position = await restoreAnalysisPosition({
      ...source.replay,
      initial: { ...source.replay.initial, threePlayerAttackProhibited: restricted },
    });
    const wins = getLegalActions(position.state)
      .filter((action) => winsSole(position, action))
      .map(encodeAction);
    if (
      JSON.stringify(wins) !== JSON.stringify(source.expected.winningActionIds) ||
      position.state.turn !== source.expected.side
    )
      throw new Error("固定戦術の正本と単独勝ち期待値が不一致です");
    rows.push({ name: `sole-win-${restricted}`, position, winningActionIds: wins });
  }
  return rows;
}
function winsSole(position: AnalysisPosition, action: Parameters<typeof encodeAction>[0]) {
  const result = applyAction(position.state, position.state.turn!, action);
  if (!result.ok || result.state.status !== "finished" || result.state.result.mode !== "singles")
    return false;
  const winners = result.state.result.standings.filter((row) => row.rank === 1);
  return winners.length === 1 && winners[0].side === position.state.turn;
}
