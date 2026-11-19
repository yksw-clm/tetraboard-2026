import { env } from "cloudflare:workers";
import { expect, test, vi } from "vitest";
import { tournamentLobbySchema, tournamentLobbySectionsSchema } from "@tetraboard/protocol";
import { gameIds } from "@tetraboard/protocol/games";
import { lobbySections, publicSummary, readTournament } from "../src/adapters/tournament/store";
import { useTournamentApiFixtures, fetchWith } from "./tournamentApiFixtures";

useTournamentApiFixtures();

async function seedLobbyTournament(
  id: number | null,
  startsAtMs: number,
  endsAtMs: number,
  finalizedAtMs: number | null = null,
) {
  const key = crypto.randomUUID();
  await env.APP_DB.prepare(`INSERT INTO tournaments(key,public_id,name,starts_at_ms,ends_at_ms,published,finalized_at_ms,created_at_ms,updated_at_ms)
    VALUES(?,?,?,?,?,?,?,?,?)`)
    .bind(
      key,
      id,
      `大会${id ?? "下書き"}`,
      startsAtMs,
      endsAtMs,
      id === null ? 0 : 1,
      finalizedAtMs,
      startsAtMs,
      startsAtMs,
    )
    .run();
  return { key, id };
}

function lobbyReadBindings() {
  return {
    ...env,
    TOURNAMENT_COORDINATOR: {
      getByName: () => ({ refresh: async () => {} }),
    } as unknown as Env["TOURNAMENT_COORDINATOR"],
  };
}

test("ゲーム別大会ロビーは開催中と終了24時間未満・全開催前を分け、旧単一応答を維持する", async () => {
  const now = 1_800_000_000_000,
    day = 86_400_000;
  const time = vi.spyOn(Date, "now").mockReturnValue(now);
  try {
    const active = await seedLobbyTournament(10, now - 1000, now + 1000);
    await seedLobbyTournament(21, now - 5000, now - 2000, now - 1000);
    await seedLobbyTournament(20, now - 6000, now - 2000);
    await seedLobbyTournament(30, now - day - 1000, now - day, now - 1);
    await seedLobbyTournament(31, now - day - 2000, now - day - 1);
    await seedLobbyTournament(32, now - day - 1000, now - day + 1, now - 1);
    await seedLobbyTournament(42, now + 10000, now + 20000);
    await seedLobbyTournament(41, now + 10000, now + 20000);
    await seedLobbyTournament(null, now - 1000, now + 1000);
    await seedLobbyTournament(null, now + 10000, now + 20000);
    const bindings = lobbyReadBindings();
    const response = await fetchWith(
      "/api/tournaments/lobby?view=sections&game=four-shogi",
      undefined,
      bindings,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const sections = tournamentLobbySectionsSchema.parse(await response.json());
    expect(sections.current.map((tournament) => [tournament.id, tournament.status])).toEqual([
      [10, "active"],
      [21, "finished"],
      [20, "settling"],
      [32, "finished"],
    ]);
    expect(sections.upcoming.map((tournament) => tournament.id)).toEqual([41, 42]);
    expect(sections.serverTimeMs).toBe(now);
    expect(JSON.stringify(sections)).not.toContain(active.key);
    const oldResponse = await fetchWith("/api/tournaments/lobby", undefined, bindings);
    const legacy: unknown = await oldResponse.json();
    expect(Object.keys(legacy as object)).toEqual(["tournament"]);
    expect(tournamentLobbySchema.parse(legacy).tournament?.id).toBe(10);
    for (const game of gameIds.filter((game) => game !== "four-shogi")) {
      const empty = await fetchWith(
        `/api/tournaments/lobby?view=sections&game=${game}`,
        undefined,
        bindings,
      );
      expect(tournamentLobbySectionsSchema.parse(await empty.json())).toEqual({
        current: [],
        upcoming: [],
        serverTimeMs: now,
      });
    }
    for (const suffix of [
      "?view=sections",
      "?game=four-shogi",
      "?view=other&game=four-shogi",
      "?view=sections&game=four-shogi&extra=1",
    ])
      expect((await fetchWith(`/api/tournaments/lobby${suffix}`, undefined, bindings)).status).toBe(
        400,
      );
  } finally {
    time.mockRestore();
  }
});

test("大会ロビーは開始・終了・予定終了から24時間の一致時刻で掲載区分を更新する", async () => {
  const starts = 1_800_000_000_000,
    ends = starts + 1000,
    day = 86_400_000;
  const time = vi.spyOn(Date, "now").mockReturnValue(starts - 1);
  try {
    await seedLobbyTournament(1, starts, ends);
    for (const [now, phase] of [
      [starts - 1, "upcoming"],
      [starts, "active"],
      [ends - 1, "active"],
      [ends, "settling"],
      [ends + day - 1, "settling"],
      [ends + day, null],
    ] as const) {
      time.mockReturnValue(now);
      const response = await fetchWith(
        "/api/tournaments/lobby?view=sections&game=four-shogi",
        undefined,
        lobbyReadBindings(),
      );
      const sections = tournamentLobbySectionsSchema.parse(await response.json());
      expect(
        [...sections.current, ...sections.upcoming].map((tournament) => tournament.status),
      ).toEqual(phase === null ? [] : [phase]);
      expect(sections.serverTimeMs).toBe(now);
    }
    await env.APP_DB.prepare("UPDATE tournaments SET finalized_at_ms=? WHERE public_id=1")
      .bind(ends + day)
      .run();
    const response = await fetchWith(
      "/api/tournaments/lobby?view=sections&game=four-shogi",
      undefined,
      lobbyReadBindings(),
    );
    expect(tournamentLobbySectionsSchema.parse(await response.json()).current).toEqual([]);
  } finally {
    time.mockRestore();
  }
});

test("大会ロビーは両区分の20件以上の公開大会も省略せず返す", async () => {
  const now = 1_800_000_000_000;
  const time = vi.spyOn(Date, "now").mockReturnValue(now);
  try {
    for (let index = 30; index > 0; index--)
      await seedLobbyTournament(index, now + index * 10000, now + index * 10000 + 1000);
    for (let index = 31; index <= 60; index++)
      await seedLobbyTournament(
        index,
        now - (index - 30) * 10000 - 1000,
        now - (index - 30) * 10000,
        now - 1,
      );
    const response = await fetchWith(
      "/api/tournaments/lobby?view=sections&game=four-shogi",
      undefined,
      lobbyReadBindings(),
    );
    const sections = tournamentLobbySectionsSchema.parse(await response.json());
    expect(sections.current.map((tournament) => tournament.id)).toEqual(
      Array.from({ length: 30 }, (_, index) => index + 31),
    );
    expect(sections.upcoming.map((tournament) => tournament.id)).toEqual(
      Array.from({ length: 30 }, (_, index) => index + 1),
    );
  } finally {
    time.mockRestore();
  }
});

test("区分別の人数と状態は同じサーバー時刻を使い、既存summaryと一致する", async () => {
  const now = 1_800_000_000_000;
  const tournament = await seedLobbyTournament(1, now - 1000, now + 1000);
  const entries = [crypto.randomUUID(), crypto.randomUUID()];
  await env.APP_DB.batch(
    entries.map((id, index) =>
      env.APP_DB.prepare(
        "INSERT INTO tournament_entries(id,tournament_key,entered_at_ms,deleted) VALUES(?,?,?,?)",
      ).bind(id, tournament.key, now, index),
    ),
  );
  const matches: string[] = [];
  for (const phase of ["playing", "reserved", "saving", "saved", "aborted"]) {
    const id = crypto.randomUUID();
    matches.push(id);
    await env.APP_DB.prepare(
      "INSERT INTO tournament_matches(id,tournament_key,room_id,instance_id,phase,updated_at_ms) VALUES(?,?,?,?,?,?)",
    )
      .bind(id, tournament.key, "12345", crypto.randomUUID(), phase, now)
      .run();
  }
  await env.APP_DB.prepare(
    "INSERT INTO tournament_match_players(match_id,entry_id,account_id,player_id,operation_id) VALUES(?,?,?,?,?)",
  )
    .bind(matches[1], entries[0], "already-matched", crypto.randomUUID(), crypto.randomUUID())
    .run();
  for (const [account, expires, matchOperation] of [
    ["waiting", now + 1, null],
    ["expired", now, null],
    ["already-matched", now + 1, null],
    ["reserved", now + 1, crypto.randomUUID()],
  ] as const)
    await env.APP_DB.prepare(
      "INSERT INTO tournament_wait_reservations(account_id,tournament_key,operation_id,lease_until_ms,match_operation_id) VALUES(?,?,?,?,?)",
    )
      .bind(account, tournament.key, crypto.randomUUID(), expires, matchOperation)
      .run();
  const time = vi.spyOn(Date, "now").mockReturnValue(now + 86_400_000);
  try {
    const sections = await lobbySections(env.APP_DB, "four-shogi", now);
    const existing = await publicSummary(
      env.APP_DB,
      (await readTournament(env.APP_DB, tournament.key))!,
      now,
    );
    expect(sections.current[0]).toEqual(existing);
    expect(sections.current[0]).toMatchObject({
      status: "active",
      entryCount: 1,
      waitingCount: 1,
      playingCount: 1,
      pendingCount: 2,
      completedCount: 1,
    });
    expect(sections.serverTimeMs).toBe(now);
  } finally {
    time.mockRestore();
  }
});
