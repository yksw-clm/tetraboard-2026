import { expect, test } from "bun:test";
import { fourShogiDefinition as game, type FourShogiTypes } from "../src/definition";
import { createInitialState, getLegalActions, type FourShogiAction } from "../src";
import singles from "../../../test-fixtures/matches/shogi-singles.json";

type Work = {
  job: {
    requestId: string;
    roundId: string;
    positionRevision: number;
    expiresAt: number;
    side: "south";
  };
  events: FourShogiTypes["externalOptions"]["events"];
  profile: { profileId: string; engineVersion: string; work: number };
};
type Service = {
  requestFourShogiAiMove: (
    bindings: {
      AI_SERVICE_TOKEN: string;
      AI_GATEWAY: { fetch: (request: Request) => Promise<Response> };
    },
    work: Work,
  ) => Promise<{ action: FourShogiAction | null }>;
};

test("実際のaiServiceが送る本文と契約の要求が3プロファイル・空/全棋譜で一致する", async () => {
  // Workerの型検査環境を持ち込まず、通信境界だけを実際のモジュールで照合します。
  const service = (await import(
    new URL("../../../apps/worker/src/adapters/room/ai/fourShogiAi.ts", import.meta.url).href
  )) as Service;
  const state = createInitialState(game.catalog.defaultSettings);
  const action = getLegalActions(state)[0];
  const allEvents = singles.events.map(
    (entry) => entry.event,
  ) as FourShogiTypes["externalOptions"]["events"];
  for (const events of [[], allEvents])
    for (const work of [4096, 16384, 65536]) {
      const profile = {
        profileId: `four-shogi-lv3-work${work}-v1`,
        engineVersion: "four-shogi-lv3-v1",
        work,
      };
      const job: Work["job"] = {
        requestId: "11111111-1111-4111-8111-111111111111",
        roundId: "22222222-2222-4222-8222-222222222222",
        positionRevision: 12,
        expiresAt: Date.now() + 5000,
        side: "south",
      };
      const digest = new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(
            JSON.stringify([job.roundId, job.positionRevision, job.side, events]),
          ),
        ),
      );
      const revision = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
      const expected = {
        request_id: job.requestId,
        position_revision: revision,
        ...game.cpu.external.createRequest(state, job.side, 2, { events, profile }),
      };
      let requests = 0;
      const result = await service.requestFourShogiAiMove(
        {
          AI_SERVICE_TOKEN: "x".repeat(32),
          AI_GATEWAY: {
            fetch: async (request) => {
              requests++;
              expect(new URL(request.url).pathname).toBe("/v1/four-shogi/move");
              expect(await request.json()).toEqual(expected);
              return Response.json({
                api_version: 1,
                rules_version: 1,
                request_id: job.requestId,
                position_revision: revision,
                profile_id: profile.profileId,
                engine_version: profile.engineVersion,
                max_work: profile.work,
                max_time_ms: 500,
                action,
                diagnostics: { work: 1 },
              });
            },
          },
        },
        { job, profile, events },
      );
      expect(result.action).toEqual(action);
      expect(requests).toBe(1);
    }
});
