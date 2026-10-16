import { trialServiceLimits, type ServiceConfig } from "../src/config";
import { aiJobRequestSchema, type AiJobRequest } from "@tetraboard/protocol/four-shogi-ai";
export const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const config: ServiceConfig = {
  ...trialServiceLimits,
  codeVersion: "a".repeat(40),
  secret: "test-service-secret-".repeat(3),
  python: "python3",
  modelDirectory: "unused",
  modelId: null,
};
export function request(n = 1, kind: "cpu" | "analysis" = "analysis"): AiJobRequest {
  return aiJobRequestSchema.parse({
    schemaVersion: 1,
    serviceInstanceId: uuid(99),
    requestId: "0:" + uuid(n),
    principal: "b".repeat(64),
    codeVersion: config.codeVersion,
    engineVersion: "tetraboard-four-shogi-rules-v1",
    modelId: null,
    stateHash: "c".repeat(64),
    context:
      kind === "analysis"
        ? { kind, matchId: uuid(20), eventOffset: 0 }
        : {
            kind,
            matchId: uuid(20),
            roomId: "1234",
            instanceId: uuid(21),
            revision: 3,
            side: "south",
            deadlineAtMs: 100000,
          },
    lifetimeMs: 60000,
    budget: { timeBudgetMs: kind === "cpu" ? 500 : 30000, maxWork: 1024 },
    position: {
      schemaVersion: 1,
      rulesVersion: 1,
      ruleProfileId: "tetraboard-four-shogi-singles-v1",
      initial: {
        mode: "singles",
        players: { south: "south", west: "west", north: "north", east: "east" },
        threePlayerAttackProhibited: false,
      },
      events: [],
      eventOffset: 0,
    },
  });
}
