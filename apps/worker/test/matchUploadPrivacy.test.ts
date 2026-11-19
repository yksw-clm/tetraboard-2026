import { env } from "cloudflare:workers";
import { afterEach, expect, test } from "vitest";
import reversi from "../../../test-fixtures/matches/reversi-standard-draw.json";
import { accountFixture } from "./accountFixtures";
import { boundaryRequest } from "./roomBoundaryFixtures";
import { humanFixtureRecord } from "./matchFixtures";
import { humanShogiRecord } from "./shogiMatchFixtures";
import { standardShogiRecord } from "./standardShogiFixtures";
import { reversiMatchData } from "../src/adapters/record/reversiMatchData";
import { writeMatch } from "../src/flows/matchSave/snapshot";
import { type ShogiSaveProgress } from "../src/adapters/record/shogiMatchStore";
import { advanceShogiMatchSave } from "../src/flows/matchSave/shogi";
import { requestDeletion } from "../src/flows/accountPurge/requestDeletion";
import { readStoredMatch } from "../src/adapters/record/matchDataContracts";
import type { ProfileRatings } from "@tetraboard/protocol";

type Game = "reversi" | "four-reversi" | "shogi" | "four-shogi";
function fixture(game: Game, accountId: string) {
  if (game === "shogi" || game === "four-shogi") {
    const source = game === "shogi" ? standardShogiRecord(accountId) : humanShogiRecord(accountId);
    return {
      record: source.record,
      async save() {
        let progress: ShogiSaveProgress | null = { phase: "upload", cursor: 0 };
        while (progress)
          progress = await advanceShogiMatchSave(env.APP_DB, source.record, progress, (cursor) =>
            source.events.slice(cursor, cursor + 100),
          );
      },
    };
  }
  const record =
    game === "four-reversi"
      ? humanFixtureRecord(accountId, 1)
      : reversiMatchData.read(
          JSON.stringify({
            ...reversi.detail,
            instanceId: crypto.randomUUID(),
            participants: reversi.detail.participants.map(({ avatarUrl: _avatar, ...player }) => ({
              ...player,
              accountId: player.seat === 0 ? accountId : null,
            })),
          }),
        );
  if (game === "reversi") record.replay.id = record.id = crypto.randomUUID();
  return { record, save: () => writeMatch(env.APP_DB, record) };
}
const ids: string[] = [];
afterEach(async () => {
  await env.APP_DB.exec("DROP TRIGGER IF EXISTS reject_private_upload_publication");
  for (const id of ids.splice(0))
    await env.APP_DB.batch([
      env.APP_DB.prepare("DELETE FROM account_match_history WHERE match_id = ?").bind(id),
      env.APP_DB.prepare("DELETE FROM match_event_chunks WHERE match_id = ?").bind(id),
      env.APP_DB.prepare("DELETE FROM match_uploads WHERE id = ?").bind(id),
      env.APP_DB.prepare("DELETE FROM matches WHERE id = ?").bind(id),
    ]);
});
async function stored(table: "matches" | "match_uploads", id: string) {
  return env.APP_DB.prepare(`SELECT record_json FROM ${table} WHERE id = ?`)
    .bind(id)
    .first<string>("record_json");
}
function read(json: string, game: Game) {
  const match = readStoredMatch(json, game);
  if (match.game === "gomoku" || match.game === "four-gomoku") throw new Error("Unexpected game");
  return match.record;
}
for (const game of ["reversi", "four-reversi", "shogi", "four-shogi"] as const) {
  test(`${game}: アップロード後の公開失敗・退会を経ても、匿名化して再送できる`, async () => {
    const departing = await accountFixture();
    const remaining = await accountFixture();
    const source = fixture(game, departing.id);
    const record = source.record;
    ids.push(record.id);
    const former = record.participants[0];
    const survivor = record.participants[1];
    const name = "退会前の名前";
    const avatarKey = `avatars/${crypto.randomUUID()}.webp`;
    const publicId = crypto.randomUUID();
    await env.APP_DB.prepare(
      "UPDATE user SET name = ?, avatarKey = ?, publicProfileId = ? WHERE id = ?",
    )
      .bind(name, avatarKey, publicId, departing.id)
      .run();
    Object.assign(former, { name, kind: "human", accountId: departing.id });
    Object.assign(survivor, { kind: "human", accountId: remaining.id });
    const ratings: ProfileRatings = {
      [former.id]: { timing: "before", status: "rated", rating: 1437 },
      [survivor.id]: { timing: "before", status: "rated", rating: 1526 },
    };
    record.profileRatings = ratings;
    const pending = JSON.stringify(record);
    await env.APP_DB.prepare(`CREATE TRIGGER reject_private_upload_publication BEFORE INSERT ON matches
      WHEN NEW.id = '${record.id}' BEGIN SELECT RAISE(ABORT, 'publication unavailable'); END`).run();
    await expect(source.save()).rejects.toThrow("publication unavailable");
    expect(await stored("matches", record.id)).toBeNull();
    const uploaded = read((await stored("match_uploads", record.id))!, game);
    expect(uploaded.profileRatings).toEqual(ratings);
    expect(
      await env.APP_DB.prepare(
        "SELECT SUM(event_count) AS n FROM match_event_chunks WHERE match_id = ?",
      )
        .bind(record.id)
        .first("n"),
    ).toBeGreaterThan(0);
    await env.APP_DB.exec("DROP TRIGGER reject_private_upload_publication");
    expect(await requestDeletion(env, departing.id, crypto.randomUUID())).toBe(true);
    const hidden = read((await stored("match_uploads", record.id))!, game);
    expect(hidden.participants[0]).toMatchObject({
      name: "退会したプレイヤー",
      accountId: null,
      retired: true,
    });
    expect(hidden.profileRatings?.[former.id]).toEqual(ratings[former.id]);
    expect(JSON.stringify(record)).toBe(pending);
    // 退会による差分だけを許し、対局結果の異なる再送は拒否します。
    const endedAt = record.endedAtMs;
    record.endedAtMs++;
    await expect(source.save()).rejects.toThrow(/Conflicting .*upload/);
    record.endedAtMs = endedAt;
    await source.save();
    const json = (await stored("matches", record.id))!;
    const saved = read(json, game);
    expect(saved.game).toEqual(record.game);
    expect(saved.endedAtMs).toBe(endedAt);
    expect(saved.participants[0]).toMatchObject({
      name: "退会したプレイヤー",
      accountId: null,
      retired: true,
    });
    expect(saved.profileRatings).toEqual({ [survivor.id]: ratings[survivor.id] });
    for (const secret of [departing.id, name, avatarKey, publicId])
      expect(json).not.toContain(secret);
    expect(await stored("match_uploads", record.id)).toBeNull();
    await source.save();
    expect(await stored("matches", record.id)).toBe(json);
    expect(
      await env.APP_DB.prepare("SELECT account_id FROM account_match_history WHERE match_id = ?")
        .bind(record.id)
        .all(),
    ).toMatchObject({ results: [{ account_id: remaining.id }] });
    const detailResponse = await boundaryRequest(`/matches/${record.id}`);
    expect(detailResponse.status).toBe(200);
    const detail = (await detailResponse.json()) as {
      match: {
        participants: { id: string; name: string; avatarUrl: string | null; retired?: true }[];
      };
    };
    expect(detail.match.participants.find((player) => player.id === former.id)).toMatchObject({
      name: "退会したプレイヤー",
      avatarUrl: null,
      retired: true,
    });
    for (const secret of [name, avatarKey, publicId])
      expect(JSON.stringify(detail)).not.toContain(secret);
    const profile = await boundaryRequest(
      `/player-profile?game=${game}&source=match&matchId=${record.id}&playerId=${former.id}&includeRating=1`,
    );
    expect(profile.status).toBe(404);
    expect(await profile.json()).toEqual({ message: "退会したプレイヤーです。" });
    const own = await boundaryRequest(`/account/matches/${record.id}`, {
      headers: remaining.headers,
    });
    expect(own.status).toBe(200);
    expect(((await own.json()) as { match: { game: unknown } }).match.game).toEqual(record.game);
  });
}
