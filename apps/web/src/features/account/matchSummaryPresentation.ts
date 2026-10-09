import { type MatchHistoryParticipant, type MatchSummary } from "@tetraboard/protocol";

export type HistoryResultGroup = {
  label: string;
  emphasized: boolean;
  players: MatchHistoryParticipant[];
};

export function matchResultGroups(match: MatchSummary): HistoryResultGroup[] {
  if (match.game === "reversi") {
    const winner = match.result.winner;
    return [...match.participants]
      .sort((a, b) => Number(b.color === winner) - Number(a.color === winner))
      .map((p) => ({
        label: winner === null ? "引き分け" : winner === p.color ? "勝利" : "敗北",
        emphasized: p.color === winner,
        players: [p],
      }));
  }
  if (match.game === "shogi") {
    const winner = match.result.winner;
    return [...match.participants]
      .sort((a, b) => Number(b.side === winner) - Number(a.side === winner))
      .map((p) => ({
        label: winner === null ? "引き分け" : winner === p.side ? "勝利" : "敗北",
        emphasized: p.side === winner,
        players: [p],
      }));
  }
  if (match.game === "four-shogi") {
    const result = match.result;
    if (result.mode === "singles") {
      const order = ["south", "west", "north", "east"];
      return [...result.standings]
        .sort((a, b) => a.rank - b.rank || order.indexOf(a.side) - order.indexOf(b.side))
        .map((standing) => ({
          label: standing.rank === 1 ? "優勝" : `${standing.rank}位`,
          emphasized: standing.rank === 1,
          players: [match.participants.find((player) => player.side === standing.side)!],
        }));
    }
    const members = { "south-north": ["south", "north"], "west-east": ["west", "east"] } as const;
    const teams =
      result.winner === "west-east"
        ? (["west-east", "south-north"] as const)
        : (["south-north", "west-east"] as const);
    return teams.map((team) => ({
      label: result.winner === null ? "引き分け" : result.winner === team ? "勝利" : "敗北",
      emphasized: result.winner === team,
      players: members[team].map((side) =>
        match.participants.find((player) => player.side === side)!,
      ),
    }));
  }
  const result = match.result;
  if (result.mode === "singles") {
    const order = ["black", "white", "red", "blue"];
    return [...result.standings]
      .sort((a, b) => a.rank - b.rank || order.indexOf(a.color) - order.indexOf(b.color))
      .map((standing) => ({
        label: standing.rank === 1 ? "優勝" : `${standing.rank}位`,
        emphasized: standing.rank === 1,
        players: [match.participants.find((player) => player.color === standing.color)!],
      }));
  }
  const members = { "black-red": ["black", "red"], "white-blue": ["white", "blue"] } as const;
  const teams =
    result.winner === "white-blue"
      ? (["white-blue", "black-red"] as const)
      : (["black-red", "white-blue"] as const);
  return teams.map((team) => ({
    label: result.winner === null ? "引き分け" : result.winner === team ? "勝利" : "敗北",
    emphasized: result.winner === team,
    players: members[team].map((color) =>
      match.participants.find((player) => player.color === color)!,
    ),
  }));
}
