import drawFixture from "../../../test-fixtures/matches/shogi-singles-draw.json";
import fixture from "../../../test-fixtures/matches/shogi-singles.json";
import { fourShogiReplayEventSchema } from "@tetraboard/protocol";
import { expect, test } from "vitest";
import { requestFourShogiAiMove } from "../src/rooms/aiService";
import { calibratedFourShogiProfile, selectFourShogi } from "../src/matchmaking/fourShogiSelection";

const histories = [
  [],
  ...[fixture, drawFixture].map((match) =>
    match.events.map(({ event }) => fourShogiReplayEventSchema.parse(event)),
  ),
];

test.each([20, 25, 28])("四人将棋のAI要求本文を旧形式のまま送る（レート%d）", async (rating) => {
  const profile = calibratedFourShogiProfile(
    selectFourShogi([{ rating, ratedGames: 5 }], 20_000)!.rating.cpu!,
  )!;
  for (const events of histories) {
    const job = {
      requestId: crypto.randomUUID(),
      roundId: crypto.randomUUID(),
      positionRevision: events.length,
      side: "west" as const,
      expiresAt: Date.now() + 5000,
    };
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        JSON.stringify([job.roundId, job.positionRevision, job.side, events]),
      ),
    );
    const revision = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    const expected = JSON.stringify({
      api_version: 1,
      rules_version: 1,
      request_id: job.requestId,
      position_revision: revision,
      profile_id: profile.profileId,
      three_player_attack_prohibited: true,
      turn: job.side,
      events,
    });
    let requests = 0;
    const result = await requestFourShogiAiMove(
      {
        AI_SERVICE_TOKEN: "test-token-at-least-32-characters-long",
        AI_GATEWAY: {
          fetch: async (input) => {
            const request = new Request(input);
            requests++;
            expect(await request.text()).toBe(expected);
            return Response.json({
              api_version: 1,
              rules_version: 1,
              request_id: job.requestId,
              position_revision: revision,
              profile_id: profile.profileId,
              engine_version: profile.engineVersion,
              max_work: profile.work,
              max_time_ms: 500,
              diagnostics: { work: 0 },
              action: { type: "dropPiece", pieceKind: "pawn", to: { x: 4, y: 4 } },
            });
          },
        },
      },
      { job, profile, events },
    );
    expect(result.action).not.toBeNull();
    expect(requests).toBe(1);
  }
});
