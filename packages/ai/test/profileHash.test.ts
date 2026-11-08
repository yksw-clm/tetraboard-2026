import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  return value;
}

test("ServiceとBenchmarkで共有するprofileの内容はSHA-256で識別できる", async () => {
  const file = JSON.parse(
    await readFile(new URL("../configs/profiles-v1.json", import.meta.url), "utf8"),
  ) as { profiles: { id: string; config: unknown; profile_hash: string }[] };
  expect(file.profiles.map((p) => p.id)).toEqual([
    "lv1-v1",
    "lv2-v1",
    "lv3-v1",
    "lv4-v1",
    "lv5-v1",
  ]);
  for (const profile of file.profiles)
    expect(Bun.CryptoHasher.hash("sha256", JSON.stringify(canonical(profile.config)), "hex")).toBe(
      profile.profile_hash,
    );
});
