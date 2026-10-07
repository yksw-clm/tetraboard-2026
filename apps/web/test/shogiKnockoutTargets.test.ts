import { expect, test } from "bun:test";
import { sides } from "@tetraboard/four-shogi";
import { fourShogiMatchDetailSchema, fourShogiReplayEventSchema } from "@tetraboard/protocol";
import { shogiArchives } from "../../../test-fixtures/matches";
import { shogiKnockoutTargets } from "../src/features/room/shogiKnockoutTargets";
import { getFourShogiReplayRules } from "../src/features/room/fourShogiReplayV1";
import { simultaneousMateFrames } from "./fixtures/shogiKnockouts";

for (const mode of ["singles", "doubles"] as const) {
  test(`${mode}: 同時詰みを着手者へ帰属し、その後の外部脱落や残存lastMoveは数えない`, () => {
    const frames = simultaneousMateFrames(mode);
    expect(shogiKnockoutTargets(frames)).toEqual({
      south: mode === "doubles" ? ["west", "east"] : ["west", "north"],
      west: [],
      north: [],
      east: [],
    });
    expect(frames[1]!.event?.type).toBe("action");
    expect(frames[0]!.event).toBeUndefined();
  });
}
test("第三者の飛車の空き王手も、利きを開けた着手者の撃破として表示", () => {
  expect(shogiKnockoutTargets(simultaneousMateFrames("singles", true))).toEqual({
    south: ["west", "north"],
    west: [],
    north: [],
    east: [],
  });
});
test("外部脱落に伴う詰み・合法手なし・引分提案は撃破対象にしない", () => {
  const frames = simultaneousMateFrames();
  const initial = frames[0]!;
  const after = frames[1]!;
  for (const reason of [
    "resigned",
    "left",
    "timeout",
    "disconnected",
    "no_legal_actions",
  ] as const) {
    expect(
      shogiKnockoutTargets([
        initial,
        {
          ...after,
          game: {
            ...after.game,
            eliminations: after.game.eliminations.map((entry) => ({ ...entry, reason })),
          },
        },
      ]).south,
    ).toEqual([]);
  }
  for (const event of [
    { type: "eliminate", side: "east", reason: "timeout" },
    { type: "drawProposal", side: "south", proposed: true },
  ]) {
    expect(
      shogiKnockoutTargets([initial, { ...after, event: fourShogiReplayEventSchema.parse(event) }])
        .south,
    ).toEqual([]);
  }
});
for (const fixture of shogiArchives) {
  test(`${fixture.name}: 完全な固定棋譜から算出し、シングルスは保存撃破数と一致`, () => {
    const match = fourShogiMatchDetailSchema.parse(fixture.detail);
    const rules = getFourShogiReplayRules(match.replay.rulesVersion);
    let state = rules.initialize(match.replay.initial);
    const frames = [rules.createFrame(state)];
    for (const entry of fixture.events) {
      const event = fourShogiReplayEventSchema.parse(entry.event);
      const next = rules.applyEvent(state, event);
      if (!next.ok) throw new Error("Invalid archive");
      state = next.state;
      frames.push(rules.createFrame(state, event));
    }
    const targets = shogiKnockoutTargets(frames);
    for (const side of sides) {
      expect(new Set(targets[side]).size).toBe(targets[side].length);
      if (match.game.mode === "singles") expect(targets[side].length).toBe(match.knockouts[side]);
    }
  });
}
