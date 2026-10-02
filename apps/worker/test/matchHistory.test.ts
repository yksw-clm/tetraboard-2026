import { env } from "cloudflare:workers";
import { afterEach, expect, test, vi } from "vitest";
import { createInitialState, eliminateColor } from "@tetraboard/four-reversi";
import { listMatchesContract, type RoomMode } from "@tetraboard/protocol";
import { accountFixture } from "./accountFixtures";
import { matchClients, matchSetup, matchStart, matchLeave, matchRequest } from "./matchFixtures";
import { writeMatch, type MatchRecord } from "../src/rooms/matchStore";

const namespaces = new Map<string, string>();
function fixtureRecord(accountId: string, index: number, mode: RoomMode = "singles"): MatchRecord {
  const initial = createInitialState(mode);
  let game = initial;
  const steps: MatchRecord["replay"]["steps"] = [];
  for (const color of (mode === "singles" ? ["black", "white", "red"] : ["black"]) as (
    | "black"
    | "white"
    | "red"
  )[]) {
    const result = eliminateColor(game, color);
    if (!result.ok) throw new Error("Elimination failed");
    game = result.state;
    steps.push({
      action: { type: "eliminate", color, reason: "left" },
      game: JSON.parse(JSON.stringify(game)),
      passedColors: [...result.passedColors],
    });
  }
  if (game.status !== "finished") throw new Error("Fixture should finish");
  if (!namespaces.has(accountId)) namespaces.set(accountId, crypto.randomUUID().slice(0, 8));
  const id = `${namespaces.get(accountId)}-0000-4000-8000-${String(index).padStart(12, "0")}`;
  return {
    id,
    roomId: "12345",
    instanceId: crypto.randomUUID(),
    startedAtMs: 1700000000000,
    endedAtMs: 1700000001000,
    settings: { game: "four-reversi", mode, timeControl: { mainTimeMs: 300000, byoyomiMs: 30000 } },
    participants: [
      {
        id: crypto.randomUUID(),
        name: "開始時の名前",
        kind: "human",
        color: "black",
        seat: 0,
        accountId,
      },
      {
        id: crypto.randomUUID(),
        name: "ゲスト",
        kind: "human",
        color: "white",
        seat: 1,
        accountId: null,
      },
      { id: crypto.randomUUID(), name: "CPU Lv1", kind: "cpu", color: "red", seat: 2, level: 1 },
      { id: crypto.randomUUID(), name: "CPU Lv2", kind: "cpu", color: "blue", seat: 3, level: 2 },
    ],
    game,
    eliminations: steps.map((step) => ({ color: step.action.color, reason: "left" })),
    replay: { id, initial: JSON.parse(JSON.stringify(initial)), steps },
  };
}
async function history(
  user: Awaited<ReturnType<typeof accountFixture>>,
  mode: RoomMode = "singles",
  cursor?: string,
) {
  const query = new URLSearchParams({ mode });
  if (cursor) query.set("cursor", cursor);
  const response = await matchRequest(`/account/matches?${query}`, {
    headers: { Cookie: user.cookie },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  return listMatchesContract.response.parse(await response.json());
}
afterEach(() => {
  for (const c of matchClients.splice(0)) c.close();
});

for (const count of [0, 20, 21, 41]) {
  test(`${count}件の履歴を同時刻でも重複なく20件ずつ新しい順に取得する`, async () => {
    const user = await accountFixture();
    for (let i = 1; i <= count; i++) await writeMatch(env.APP_DB, fixtureRecord(user.id, i));
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await history(user, "singles", cursor);
      expect(page.matches).toHaveLength(Math.min(20, count - ids.length));
      ids.push(...page.matches.map((m) => m.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(ids).toEqual(
      Array.from({ length: count }, (_, i) => fixtureRecord(user.id, count - i).id),
    );
  });
}

test("本人の対局とモードだけを返し、内部ID・盤面・棋譜・部屋識別子を公開しない", async () => {
  const user = await accountFixture();
  const other = await accountFixture();
  const record = fixtureRecord(user.id, 1);
  await writeMatch(env.APP_DB, record);
  await writeMatch(env.APP_DB, fixtureRecord(user.id, 2, "doubles"));
  await writeMatch(env.APP_DB, fixtureRecord(other.id, 3));
  expect((await history(user)).matches.map((m) => m.id)).toEqual([record.id]);
  expect((await history(user, "doubles")).matches).toHaveLength(1);
  expect((await history(other)).matches).toHaveLength(1);
  const body = JSON.stringify(await history(user));
  for (const privateValue of [
    user.id,
    other.id,
    record.instanceId,
    '"accountId"',
    '"board"',
    '"replay"',
    '"roomId"',
    '"settings"',
  ])
    expect(body).not.toContain(privateValue);
});

test("開始時の名前と現在のアイコンを返し、削除したアイコンは仮アイコンになる", async () => {
  const user = await accountFixture();
  await writeMatch(env.APP_DB, fixtureRecord(user.id, 1));
  const key = `avatars/${crypto.randomUUID()}.webp`;
  await env.APP_DB.prepare("UPDATE user SET name = ?, avatarKey = ? WHERE id = ?")
    .bind("変更後の名前", key, user.id)
    .run();
  expect((await history(user)).matches[0].participants[0]).toMatchObject({
    name: "開始時の名前",
    avatarUrl: `/api/avatars/${key.slice(8, -5)}`,
  });
  await env.APP_DB.prepare("UPDATE user SET avatarKey = NULL WHERE id = ?").bind(user.id).run();
  expect((await history(user)).matches[0].participants[0]).toMatchObject({ avatarUrl: null });
});

test("実際の終局保存が本人の履歴へつながり、他人の履歴には出ない", async () => {
  const setup = await matchSetup("doubles");
  await matchStart(setup);
  const other = await accountFixture();
  expect((await history(setup.user, "doubles")).matches).toHaveLength(0);
  await matchLeave(setup.id, setup.memberships[0]);
  await vi.waitFor(async () =>
    expect((await history(setup.user, "doubles")).matches).toHaveLength(1),
  );
  expect((await history(other, "doubles")).matches).toHaveLength(0);
});

test("不正なモード・カーソルと未認証を拒否し、D1障害では503を返す", async () => {
  const user = await accountFixture();
  expect((await matchRequest("/account/matches?mode=singles")).status).toBe(401);
  for (const query of [
    "",
    "mode=other",
    "mode=singles&cursor=bad",
    "mode=doubles&cursor=999999999999999999999:00000000-0000-4000-8000-000000000001",
  ]) {
    const response = await matchRequest(`/account/matches?${query}`, {
      headers: { Cookie: user.cookie },
    });
    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  }
  await env.APP_DB.exec("ALTER TABLE matches RENAME TO matches_unavailable");
  try {
    const response = await matchRequest("/account/matches?mode=singles", {
      headers: { Cookie: user.cookie },
    });
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  } finally {
    await env.APP_DB.exec("ALTER TABLE matches_unavailable RENAME TO matches");
  }
  // A broken session lookup must not turn into an anonymous/empty successful response.
  await env.APP_DB.exec("ALTER TABLE session RENAME TO session_unavailable");
  try {
    expect(
      (await matchRequest("/account/matches?mode=singles", { headers: { Cookie: user.cookie } }))
        .status,
    ).toBe(503);
  } finally {
    await env.APP_DB.exec("ALTER TABLE session_unavailable RENAME TO session");
  }
});
