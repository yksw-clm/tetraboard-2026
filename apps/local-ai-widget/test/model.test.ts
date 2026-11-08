import { expect, test } from "bun:test";
import {
  observationSchema,
  positionIdentity,
  validateResult,
  supportedUrl,
  analysisRequestSchema,
} from "../src/model";
import { localProfileIds, localProfile } from "../src/profiles";
import { observation, requestFor, responseFor } from "./fixtures";
test("観測情報は局面と識別子だけを保持しプロフィール・tokenを除く", () => {
  const o = observationSchema.parse({ ...observation(), token: "secret", chat: ["private"] });
  expect(o).not.toHaveProperty("token");
  expect(o).not.toHaveProperty("chat");
  expect(
    observationSchema.parse({
      ...observation(),
      players: [{ ...observation().players[0], name: "private" }],
    }).players[0],
  ).not.toHaveProperty("name");
});
test("局面識別は時計更新を無視し、接続世代・脱落順・手番開始を区別する", () => {
  const o = observation(),
    key = positionIdentity(o, "https://tetraboard.net", 1);
  expect(positionIdentity({ ...o, serverNowMs: 999 }, "https://tetraboard.net", 1)).toBe(key);
  expect(positionIdentity({ ...o, generation: 2 }, "https://tetraboard.net", 1)).not.toBe(key);
  expect(positionIdentity({ ...o, turnStartedAt: 200 }, "https://tetraboard.net", 1)).not.toBe(key);
  expect(positionIdentity(o, "https://tetraboard.net", 2)).not.toBe(key);
});
test("同率を正規化せず、合法・非重複・正しい対象の候補だけ受理する", () => {
  const r = requestFor(),
    result = responseFor(r);
  expect(validateResult(result, r).candidates[0].solo_wins.reduce((a, b) => a + b, 0)).toBe(4);
  for (const invalid of [
    { ...result, request_id: crypto.randomUUID() },
    { ...result, cancelled: true },
    { ...result, candidates: [result.candidates[0], result.candidates[0]] },
    { ...result, candidates: [{ ...result.candidates[0], solo_wins: [10, 10, 0, 0] }] },
  ])
    expect(() => validateResult(invalid, r)).toThrow();
});
test("許可する接続先を固定し類似ドメインを拒否する", () => {
  expect(supportedUrl("https://tetraboard.net/rooms/12345")).toBe(true);
  for (const url of [
    "https://tetraboard.net.evil.test/",
    "http://tetraboard.net/",
    "http://192.168.1.1/",
    "http://127.0.0.1:9999/",
  ])
    expect(supportedUrl(url)).toBe(false);
});
test("許可したprofileだけ要求でき、応答のprofile・hash・実効予算をすべて照合する", () => {
  for (const id of localProfileIds) {
    const request = { ...requestFor(), profile_id: id };
    const result = responseFor(request);
    expect(analysisRequestSchema.parse(request).profile_id).toBe(id);
    expect(validateResult(result, request)).toEqual(result);
    const other = localProfileIds.find((p) => p !== id)!;
    for (const invalid of [
      {
        ...result,
        profile_id: other,
        profile_hash: localProfile(other).hash,
        effective_limits: localProfile(other).limits,
      },
      { ...result, profile_hash: "a".repeat(64) },
      { ...result, effective_limits: { ...result.effective_limits, max_iterations: 1 } },
      { ...result, effective_limits: { ...result.effective_limits, max_nodes: 1 } },
      { ...result, effective_limits: { ...result.effective_limits, max_time_ms: 5000 } },
    ])
      expect(() => validateResult(invalid, request)).toThrow();
  }
  for (const invalid of [
    { ...requestFor(), profile_id: "lv6-v1" },
    { ...requestFor(), seed: 1 },
    { ...requestFor(), limits: { max_nodes: 999999 } },
  ])
    expect(analysisRequestSchema.safeParse(invalid).success).toBe(false);
});
