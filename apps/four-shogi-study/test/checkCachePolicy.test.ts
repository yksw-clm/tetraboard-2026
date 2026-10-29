import { expect, test } from "bun:test";
import { tacticalCases } from "../../../packages/four-shogi/bench/tactics";
import { createStudyRootSearch } from "../../../packages/four-shogi/src/studySearch";
import { tacticInput, drainTask } from "../bench/tacticsDiagnostics";
import { restoreStudyPosition } from "../src/domain/study";

test("広いv5では王手キャッシュを既定で使わず、明示指定とv6の再利用は維持する", async () => {
  const position = await restoreStudyPosition(
    tacticInput(tacticalCases().find((t) => t.id === "inactive-rook-false-north")!.state),
  );
  for (const option of [
    { strategy: "adaptive", reuseChecks: undefined, expected: false },
    { strategy: "adaptive", reuseChecks: true, expected: true },
    { strategy: "dual", reuseChecks: undefined, expected: true },
    { strategy: "dual", reuseChecks: false, expected: false },
  ] as const) {
    const search = createStudyRootSearch(position, {
      ...option,
      measureDetails: true,
      dangerWork: 0,
    });
    try {
      expect(drainTask(search, performance.now() + 5000, true).complete).toBe(true);
      search.startTask(
        0,
        3,
        false,
        option.strategy === "dual" ? { phase: "deep", width: 2, ownWidth: 3 } : undefined,
      );
      expect(drainTask(search, performance.now() + 5000).complete).toBe(true);
      const hits = search.snapshot().performance!.checkCacheHits ?? 0;
      if (option.expected) expect(hits).toBeGreaterThan(0);
      else expect(hits).toBe(0);
    } finally {
      search.dispose();
    }
  }
});
