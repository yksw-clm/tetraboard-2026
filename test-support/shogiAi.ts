import type { AiStatus } from "../packages/protocol/src/shogiAi";
export function aiStatusFixture(now = Date.now()): AiStatus {
  return {
    schemaVersion: 1,
    generatedAt: now,
    heartbeatAt: now,
    startedAt: now,
    learningEndsAt: now + 86400000,
    profiles: (["singles-restricted", "singles-unrestricted"] as const).map((profileId) => ({
      profileId,
      candidate: null,
      run: null,
      champion: {
        schemaVersion: 1,
        id: profileId + "-initial",
        profileId,
        generation: 0,
        parentId: null,
        codeCommit: "test",
        sourceHash: "a".repeat(64),
        createdAt: now,
        maxWork: 16384,
        weights: {
          undefended: 1.6,
          exchange: 0.9,
          kingRing: 55,
          check: 70,
          mobility: 3,
          advancement: 6,
          shelter: 18,
          survival: 5000,
        },
      },
    })),
    learning: { stage: "selfplay", games: 0, gamesPerHour: 0, checkpointAt: null, activeGames: [] },
    resources: {
      memoryBytes: 1024,
      scope: "controller",
      memoryLimitBytes: null,
      cpuSeconds: 0,
      diskFreeBytes: 100 * 1024 ** 3,
    },
    recentErrors: [],
  };
}
