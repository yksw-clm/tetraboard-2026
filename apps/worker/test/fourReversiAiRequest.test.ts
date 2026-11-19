import { expect, test } from "vitest";
import { createInitialState, eliminateColor } from "@tetraboard/four-reversi";
import { fourReversiStateSchema } from "@tetraboard/protocol";
import { namedCpuProfile } from "../src/adapters/matchmaking/cpuProfiles";
import { requestAiMove } from "../src/adapters/room/ai/fourReversiAi";
import type { ExternalCpuWork } from "../src/adapters/room/games/four-reversi/progress";

for (const profile of [undefined, "lv1-v1", "lv3-v1"] as const)
  for (const extendedRules of [false, true])
    for (const level of [1, 2] as const) {
      test(`要求本文は旧実装と一致する: profile=${profile} 拡張=${extendedRules} Lv${level}`, async () => {
        const initial = createInitialState("singles");
        const dropped = eliminateColor(initial, "red");
        if (!dropped.ok) throw Error("Expected elimination");
        const state = fourReversiStateSchema.parse(extendedRules ? dropped.state : initial);
        if (state.status !== "playing") throw Error("Expected playing");
        const metadata = profile ? namedCpuProfile(profile) : undefined;
        const serviceProfile = metadata
          ? {
              profile_id: metadata.id,
              profile_hash: metadata.hash,
              ...(profile === "lv3-v1" ? { limits: { max_nodes: 100 } } : {}),
            }
          : undefined;
        const job: ExternalCpuWork["job"] = {
          instanceId: "test-instance",
          roundId: "test-round",
          playerId: "test-cpu",
          color: state.turn,
          level,
          turnStartedAt: 1000,
          positionKey: "test-position",
          requestId: crypto.randomUUID(),
          expiresAt: Date.now() + 30_000,
          ...(serviceProfile ? { serviceProfile } : {}),
          ...(extendedRules ? { extendedRules: true } : {}),
        };
        const { requestId, expiresAt: _expiresAt, ...context } = job;
        const digest = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(JSON.stringify(context)),
        );
        const revision = Array.from(new Uint8Array(digest), (v) =>
          v.toString(16).padStart(2, "0"),
        ).join("");
        const expected = {
          api_version: profile ? 2 : 1,
          game_id: "four-reversi",
          ruleset_version: extendedRules ? "four-reversi-singles-v2" : "four-reversi-singles-v1",
          state_version: extendedRules ? 2 : 1,
          request_id: requestId,
          position_revision: revision,
          ...(serviceProfile
            ? {
                profile_id: serviceProfile.profile_id,
                ...(serviceProfile.limits ? { limits: serviceProfile.limits } : {}),
              }
            : { agent_id: level === 1 ? "four-reversi-random-v1" : "four-reversi-greedy-v1" }),
          seed: Number.parseInt(revision.slice(0, 8), 16),
          state: {
            board: state.board,
            ...(extendedRules ? { eliminatedColors: state.eliminatedColors } : {}),
            turn: state.turn,
            moveNumber: state.moveNumber,
            lastMove: state.lastMove,
            consecutivePasses: state.consecutivePasses,
          },
        };
        const requests: unknown[] = [];
        const before = structuredClone({ job, game: state });
        const result = await requestAiMove(
          {
            AI_SERVICE_TOKEN: "test-ai-service-token-at-least-32-characters",
            AI_GATEWAY: {
              fetch: async (request: Request) => {
                expect(new URL(request.url).pathname).toBe(profile ? "/v2/move" : "/v1/move");
                requests.push(await request.json());
                return new Response(null, { status: 400 });
              },
            },
          },
          { job, game: state },
        );
        expect(result).toEqual({ position: null, reason: "http_400" });
        expect(requests).toEqual([expected]);
        expect({ job, game: state }).toEqual(before);
      });
    }
