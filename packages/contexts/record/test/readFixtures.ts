import {
  encodeSnapshotMatch,
  rebuildSnapshotMatch,
  createMatchChunk,
  type RecordMatch,
  type StoredMatch,
  type MatchReadValidation,
} from "../src";
import fourReversi from "../../../../test-fixtures/matches/reversi-singles-normal.json";
import reversi from "../../../../test-fixtures/matches/reversi-standard-draw.json";
import gomoku from "../../../../test-fixtures/matches/gomoku-on-five.json";
import fourGomoku from "../../../../test-fixtures/matches/four-gomoku-singles-ranked.json";
import fourShogi from "../../../../test-fixtures/matches/shogi-singles.json";
import shogi from "../../../../test-fixtures/matches/standard-shogi-cpu-1.json";

function snapshot(detail: unknown): RecordMatch {
  const data = structuredClone(detail) as RecordMatch["record"] & { selfPlayerId?: string };
  delete data.selfPlayerId;
  data.instanceId = "instance";
  data.participants = data.participants.map((p) => {
    const { avatarUrl: _avatar, ...player } = p as typeof p & { avatarUrl?: string | null };
    return p.kind === "human" ? { ...player, accountId: p.seat === 0 ? "self" : null } : player;
  }) as typeof data.participants;
  return { game: data.settings.game, record: data } as RecordMatch;
}
export const matches = [
  snapshot(reversi.detail),
  snapshot(fourReversi.detail),
  snapshot(gomoku.detail),
  snapshot(fourGomoku.detail),
  snapshot(fourShogi.detail),
  snapshot({
    id: "standard-shogi",
    roomId: "room",
    instanceId: "instance",
    startedAtMs: 1,
    endedAtMs: 2,
    settings: { game: "shogi", timeControl: { initialMs: 60000, byoyomiMs: 10000 } },
    participants: [
      { id: "cpu-south", side: "south", seat: 0, name: "CPU", kind: "cpu", level: 1 },
      { id: "cpu-north", side: "north", seat: 1, name: "CPU", kind: "cpu", level: 1 },
    ],
    game: shogi.detail.game,
    replay: shogi.detail.replay,
  }),
];
export function stored(match: RecordMatch) {
  if (match.game === "shogi" || match.game === "four-shogi") return { match, chunks: [] };
  const encoded = encodeSnapshotMatch(match.record);
  return {
    match: { game: match.game, record: encoded.record } as StoredMatch,
    chunks: Array.from({ length: Math.ceil(encoded.events.length / 100) }, (_, i) =>
      createMatchChunk(
        i,
        encoded.events.length,
        encoded.events.slice(i * 100, i * 100 + 100),
        (e) => e,
      ),
    ),
  };
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => [key, canonical(value)]),
    );
  return value;
}
export const decode = (json: string, game: string): StoredMatch => {
  const record = canonical(JSON.parse(json)) as StoredMatch["record"];
  if (record.settings.game !== game) throw new Error("Stored match game mismatch");
  return { game, record } as StoredMatch;
};
export const validation: MatchReadValidation<StoredMatch, RecordMatch> = {
  readStored: decode,
  readComplete: (json, game) => decode(json, game) as RecordMatch,
  rebuildMatch(match, events) {
    if (match.game === "shogi" || match.game === "four-shogi")
      throw new Error("Expected snapshot game");
    const source = matches.find((source) => source.game === match.game)!;
    if (source.game === "shogi" || source.game === "four-shogi")
      throw new Error("Expected snapshot game");
    return rebuildSnapshotMatch(
      match.record,
      events,
      (initial, parsed) => {
        const expected = encodeSnapshotMatch(source.record).events;
        if (
          JSON.stringify(canonical(initial)) !==
            JSON.stringify(canonical(source.record.replay.initial)) ||
          JSON.stringify(canonical(parsed)) !== JSON.stringify(canonical(expected))
        )
          throw new Error("Unexpected replay input");
        return source.record.replay.steps.map((step) => step.game);
      },
      (event) => validation.parseEvent(match.game, event),
    );
  },
  parseEvent: (_game, event) => {
    if (!event || typeof event !== "object" || !("type" in event)) throw new Error("Invalid event");
    return event;
  },
};
