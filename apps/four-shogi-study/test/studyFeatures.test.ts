import { expect, test } from "bun:test";
import { createStudy, parseStudyDocument, updateStudySettings } from "../src/domain/study";

test("新規検討は南を人間、残りをCPUとし、各席の時間と有限または継続検討を保存する", async () => {
  const study = await createStudy();
  expect(study.settings.seats.south.controller).toBe("human");
  expect(study.settings.seats.east.controller).toBe("cpu");
  const next = updateStudySettings(study, {
    analysisTimeMs: null,
    seats: { ...study.settings.seats, east: { controller: "cpu", thinkTimeMs: 15000 } },
  });
  const restored = await parseStudyDocument(JSON.parse(JSON.stringify(next)));
  expect(restored.settings.analysisTimeMs).toBeNull();
  expect(restored.settings.seats.east.thinkTimeMs).toBe(15000);
});

test("旧形式のCPU一席設定を読み込むと担当席と棋譜を保つ", async () => {
  const study = await createStudy({ cpuSide: "north" });
  const raw = JSON.parse(JSON.stringify(study));
  delete raw.settings.seats;
  delete raw.settings.analysisTimeMs;
  const restored = await parseStudyDocument(raw);
  expect(restored.settings.seats.north.controller).toBe("cpu");
  expect(restored.settings.seats.south.controller).toBe("human");
  expect(restored.settings.seats.east.controller).toBe("human");
  expect(restored.nodes).toEqual(study.nodes);
});
