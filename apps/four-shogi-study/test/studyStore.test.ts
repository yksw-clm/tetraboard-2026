import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStudy, updateStudySettings } from "../src/domain/study";
import { StudyStore } from "../src/domain/store";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function store() {
  const directory = await mkdtemp(join(tmpdir(), "four-shogi-study-test-"));
  directories.push(directory);
  return new StudyStore(directory);
}

test("自動保存は更新番号を照合し、前回バックアップと現在の選択・設定を保存する", async () => {
  const storage = await store();
  const study = await createStudy({ title: "検討保存", nowMs: 0 });
  await storage.save(study, null);
  const updated = updateStudySettings(study, { threads: 3 }, { nowMs: 1 });
  await storage.save(updated, 0);
  expect(await storage.load(study.id)).toEqual(updated);
  const backup = JSON.parse(
    await readFile(join(storage.directory, `${study.id}.json.bak`), "utf8"),
  );
  expect(backup).toEqual(study);
  await expect(storage.save(updated, 0)).rejects.toThrow("更新");
  await expect(storage.save(study)).rejects.toThrow("古い");
  expect(await storage.list()).toEqual([updated]);
  expect((await readdir(storage.directory)).some((name) => name.endsWith(".tmp"))).toBe(false);
});

test("破損保存は前回の正常バックアップから復元し、破損原本を残す", async () => {
  const storage = await store();
  const study = await createStudy();
  await storage.save(study, null);
  await storage.save(updateStudySettings(study, { threads: 3 }), 0);
  await writeFile(join(storage.directory, `${study.id}.json`), "{broken");
  const restarted = new StudyStore(storage.directory);
  expect(await restarted.load(study.id)).toEqual(study);
  expect(restarted.recoveries[0].studyId).toBe(study.id);
  expect((await readdir(storage.directory)).some((name) => name.includes(".corrupt-"))).toBe(true);
  await restarted.save(updateStudySettings(study, { threads: 2 }), 0);
  expect((await restarted.load(study.id))?.settings.threads).toBe(2);
});

test("同時保存の競合とパス逸脱を拒否し、壊れた別ファイルで一覧全体を失わない", async () => {
  const storage = await store();
  const study = await createStudy();
  await storage.save(study, null);
  const outcomes = await Promise.allSettled([
    storage.save(updateStudySettings(study, { threads: 2 }), 0),
    storage.save(updateStudySettings(study, { threads: 3 }), 0),
  ]);
  expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(outcomes.filter((result) => result.status === "rejected")).toHaveLength(1);
  await expect(storage.load("../private")).rejects.toThrow("ID");
  await writeFile(join(storage.directory, "broken.json"), "garbage");
  expect(await storage.list()).toHaveLength(1);
  expect(storage.errors[0].studyId).toBe("broken");
  await expect(storage.load("broken")).rejects.toThrow("バックアップ");
});
