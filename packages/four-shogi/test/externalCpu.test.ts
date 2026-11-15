import { expect, test } from "bun:test";
import { fourShogiDefinition as game, type FourShogiTypes } from "../src/definition";
import {
  createInitialState,
  getActionAvailability,
  getLegalActions,
  type FourShogiState,
} from "../src";
import { fixture, move, drop } from "./helpers";
import singles from "../../../test-fixtures/matches/shogi-singles.json";

const external = game.cpu.external;

test("局面のキーは履歴の保存方法に依存せず、操作に関わる状態の変化を識別する", () => {
  const state = createInitialState(game.catalog.defaultSettings);
  if (state.status !== "playing") throw new Error("Expected playing");
  const key = external.getPositionKey(state);
  expect(external.getPositionKey(structuredClone(state))).toBe(key);
  expect(external.getPositionKey({ ...state, repetitions: {} })).toBe(key);
  const variants: FourShogiState[] = [
    { ...state, mode: "doubles" },
    { ...state, turn: "west" },
    { ...state, moveNumber: 1 },
    { ...state, threePlayerAttackProhibited: false },
    { ...state, drawProposals: ["north"] },
    { ...state, eliminations: [{ side: "north", reason: "left", rank: 4, group: 1 }] },
    { ...state, hands: { ...state.hands, south: { ...state.hands.south, pawn: 1 } } },
    { ...state, recaptureSquares: { ...state.recaptureSquares, south: [{ x: 4, y: 4 }] } },
    {
      ...state,
      attackRelations: [
        {
          attacker: "west",
          target: "north",
          reasons: ["check"],
          targetPieceIds: [],
          pendingSides: ["south"],
        },
      ],
    },
  ];
  for (const variant of variants) expect(external.getPositionKey(variant)).not.toBe(key);
});

test("検証済みの応答の着手・成り・駒打ちを契約の操作へ読み、合法性はルールで判定する", () => {
  const state = createInitialState(game.catalog.defaultSettings);
  for (const action of [
    ...getLegalActions(state),
    move("D3", "E3", true),
    ...(["rook", "gold", "silver", "pawn"] as const).map((kind) => drop(kind, "E5")),
  ]) {
    const before = structuredClone(action);
    const actual = external.readMove(action);
    expect(actual).toEqual(action);
    expect(action).toEqual(before);
  }
  const illegal = external.readMove(move("A1", "I9"))!;
  expect(game.rules.applyAction(state, "south", illegal).ok).toBe(false);
});

test("予備手はWorkerのlegalActionsと同じ先頭で、手番外・終局・候補なしはnull", () => {
  for (const state of [createInitialState(game.catalog.defaultSettings), fixture()]) {
    expect(external.fallbackAction(state, "south")).toEqual(
      getActionAvailability(state).legalActions[0],
    );
    expect(external.fallbackAction(state, "west")).toBeNull();
  }
  const empty = fixture({ eliminations: [{ side: "south", reason: "left", rank: 4, group: 1 }] });
  expect(external.fallbackAction(empty, "south")).toBeNull();
  const finished = game.rules.eliminateSeat(
    createInitialState({ ...game.catalog.defaultSettings, mode: "doubles" }),
    "west",
    "left",
  ).state;
  expect(external.fallbackAction(finished, "south")).toBeNull();
});

test("要求本文は全棋譜とプロファイルを受け取り、既存aiServiceと同じ本文を作れる", () => {
  const state = createInitialState(game.catalog.defaultSettings);
  const events = singles.events.map(
    (entry) => entry.event,
  ) as FourShogiTypes["externalOptions"]["events"];
  const before = structuredClone(events);
  for (const work of [4096, 16384, 65536]) {
    const profile = {
      profileId: `four-shogi-lv3-work${work}-v1`,
      work,
      engineVersion: "four-shogi-lv3-v1",
    };
    const job = { requestId: "11111111-1111-4111-8111-111111111111", side: "south" as const };
    const revision = "a".repeat(64);
    const request = external.createRequest(state, job.side, 2, { events, profile });
    // aiService.tsと同じく、要求IDとハッシュ化したrevisionは通信側で付加します。
    const body = {
      api_version: request.api_version,
      rules_version: request.rules_version,
      request_id: job.requestId,
      position_revision: revision,
      profile_id: request.profile_id,
      three_player_attack_prohibited: request.three_player_attack_prohibited,
      turn: request.turn,
      events: request.events,
    };
    expect(JSON.stringify(body)).toBe(
      JSON.stringify({
        api_version: 1,
        rules_version: 1,
        request_id: job.requestId,
        position_revision: revision,
        profile_id: profile.profileId,
        three_player_attack_prohibited: true,
        turn: job.side,
        events,
      }),
    );
  }
  expect(events).toEqual(before);
  expect(
    external.createRequest({ ...state, threePlayerAttackProhibited: false }, "west", 1, {
      events: [],
      profile: { profileId: "custom" },
    }),
  ).toMatchObject({
    three_player_attack_prohibited: false,
    turn: "west",
    events: [],
    profile_id: "custom",
  });
});
