import { env } from "cloudflare:workers";
import {
  boardDetailSchema,
  boardPostResultSchema,
  boardRepliesSchema,
  boardReplyResultSchema,
  boardTimelineSchema,
  type BoardAttachment,
} from "@tetraboard/protocol/board";
import { afterEach, expect, test } from "vitest";
import reversi from "../../../test-fixtures/matches/reversi-doubles-normal.json";
import { D1BoardReader } from "../src/adapters/community/boardReads";
import { accountFixture } from "./accountFixtures";
import { boardRequest, openBoard, postPath, repliesPath, resetBoard } from "./boardFixtures";
import { fixTestTime } from "./fixedTimeFixture";
import { assetFixture } from "./publicAssetFixtures";
import { prepareStoredMatchFixture } from "./snapshotMatchFixtures";

const path = "/games/four-reversi/posts";
const includeAttachments = "?includeAttachments=1";
const matchIds: string[] = [];

async function matchFixture(published = true) {
  const match = { ...reversi.detail, id: crypto.randomUUID() };
  matchIds.push(match.id);
  const json = await prepareStoredMatchFixture(
    env.APP_DB,
    reversi.recordJson.replaceAll(reversi.detail.id, match.id),
  );
  const eventCount = match.replay.steps.length;
  if (published) {
    await env.APP_DB.prepare(
      "INSERT INTO matches(id,game,mode,started_at_ms,ended_at_ms,record_json) VALUES(?,?,?,?,?,?)",
    )
      .bind(
        match.id,
        match.settings.game,
        match.settings.mode,
        match.startedAtMs,
        match.endedAtMs,
        json,
      )
      .run();
  } else {
    await env.APP_DB.prepare(
      "INSERT INTO match_uploads(id,record_json,event_count,chunk_count) VALUES(?,?,?,?)",
    )
      .bind(match.id, json, eventCount, 1)
      .run();
  }
  return {
    matchId: match.id,
    eventCount,
    positionCount:
      1 + match.replay.steps.reduce((count, step) => count + 1 + step.passedColors.length, 0),
  };
}

afterEach(async () => {
  await resetBoard();
  for (const id of matchIds.splice(0))
    await env.APP_DB.batch([
      env.APP_DB.prepare("DELETE FROM match_event_chunks WHERE match_id=?").bind(id),
      env.APP_DB.prepare("DELETE FROM match_uploads WHERE id=?").bind(id),
      env.APP_DB.prepare("DELETE FROM matches WHERE id=?").bind(id),
    ]);
});

function submit(
  path: string,
  headers: HeadersInit,
  attachment?: BoardAttachment,
  requestId = crypto.randomUUID(),
) {
  return boardRequest(path, {
    method: "POST",
    headers,
    body: JSON.stringify({ text: "棋譜を共有します", requestId, attachment }),
  });
}

test("自動パスを含む局面を投稿・返信に保存し、各読み取りで返す", async () => {
  await openBoard();
  const { matchId, eventCount, positionCount } = await matchFixture();
  const author = await accountFixture();
  const replier = await accountFixture();
  const attachment = { matchId, position: positionCount - 1 };
  expect(attachment.position).toBeGreaterThan(eventCount);
  const postRequest = crypto.randomUUID();
  const response = await submit(path + includeAttachments, author.headers, attachment, postRequest);
  expect(response.status).toBe(200);
  const { post } = boardPostResultSchema.parse(await response.json());
  expect(post?.attachment).toEqual(attachment);
  const id = post!.id;
  const replyAttachment = { matchId, position: 0 };
  const replyRequest = crypto.randomUUID();
  const replyResponse = await submit(
    repliesPath(id) + includeAttachments,
    replier.headers,
    replyAttachment,
    replyRequest,
  );
  expect(replyResponse.status).toBe(200);
  const { reply } = boardReplyResultSchema.parse(await replyResponse.json());
  expect(reply?.attachment).toEqual(replyAttachment);

  const page = boardTimelineSchema.parse(
    await (await boardRequest(path + includeAttachments)).json(),
  );
  expect(page.posts).toEqual([expect.objectContaining({ id, attachment })]);
  const thread = boardDetailSchema.parse(
    await (await boardRequest(postPath(id) + includeAttachments)).json(),
  );
  expect(thread.post).toMatchObject({ attachment });
  expect(thread.replies).toEqual([
    expect.objectContaining({ id: reply!.id, attachment: replyAttachment }),
  ]);
  const replies = boardRepliesSchema.parse(
    await (await boardRequest(repliesPath(id) + includeAttachments)).json(),
  );
  expect(replies.replies).toEqual(thread.replies);
  expect(
    (await env.APP_DB.prepare("SELECT id,match_id AS matchId,position FROM board_posts").all())
      .results,
  ).toEqual(
    expect.arrayContaining([
      { id, ...attachment },
      { id: reply!.id, ...replyAttachment },
    ]),
  );

  for (const legacyResponse of [
    await boardRequest(path),
    await boardRequest(postPath(id)),
    await boardRequest(repliesPath(id)),
    await submit(path, author.headers, attachment, postRequest),
    await submit(repliesPath(id), replier.headers, replyAttachment, replyRequest),
  ]) {
    expect(legacyResponse.status).toBe(200);
    expect(JSON.stringify(await legacyResponse.json())).not.toContain('"attachment"');
  }
  const internal = await new D1BoardReader(env.APP_DB).detail(id, null);
  expect(internal).toEqual(expect.objectContaining({ post: thread.post, replies: thread.replies }));
  const html = await assetFixture().fetch(postPath(id));
  expect(html.status).toBe(200);
  expect(await html.text()).toContain('id="root"');
});

test("存在しない、未公開、別ゲーム、または範囲外の添付で投稿を保存しない", async () => {
  await openBoard();
  const { matchId, positionCount } = await matchFixture();
  const unlisted = await matchFixture(false);
  const user = await accountFixture();
  expect((await boardRequest(`/matches/${matchId}`)).status).toBe(200);
  expect((await boardRequest(`/matches/${unlisted.matchId}`)).status).toBe(404);
  const parent = await submit("/games/reversi/posts", (await accountFixture()).headers);
  const { post } = boardPostResultSchema.parse(await parent.json());
  for (const [destination, attachment] of [
    [path, { matchId: crypto.randomUUID(), position: 0 }],
    [path, { matchId: unlisted.matchId, position: 0 }],
    ["/games/reversi/posts", { matchId, position: 0 }],
    [repliesPath(post!.id), { matchId, position: 0 }],
    [path, { matchId, position: positionCount }],
    [path, { matchId, position: -1 }],
  ] as const) {
    const rejected = await submit(destination, user.headers, attachment);
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual({ message: "添付した棋譜の局面が見つかりません。" });
  }
  expect(
    (await submit(repliesPath(crypto.randomUUID()), user.headers, { matchId, position: 0 })).status,
  ).toBe(404);
  expect(await env.APP_DB.prepare("SELECT COUNT(*) AS n FROM board_posts").first("n")).toBe(1);
  expect((await submit(path, user.headers, { matchId, position: 0 })).status).toBe(200);
});

test("読み取り失敗を 503 にし、受付済みの再送では添付の一致を照合する", async () => {
  const clock = fixTestTime();
  const now = Date.now();
  await openBoard();
  const { matchId } = await matchFixture();
  const user = await accountFixture();
  const requestId = crypto.randomUUID();
  const attachment = { matchId, position: 0 };
  const accepted = await submit(path + includeAttachments, user.headers, attachment, requestId);
  expect(accepted.status).toBe(200);
  const initial = await accepted.json();
  await env.APP_DB.prepare("DELETE FROM match_event_chunks WHERE match_id=?").bind(matchId).run();
  const limited = await submit(path, user.headers, attachment);
  expect(limited.status).toBe(429);
  expect(await limited.json()).toMatchObject({ availableAtMs: now + 30_000 });
  clock.mockReturnValue(now + 30_000);
  const failed = await submit(path, user.headers, attachment);
  expect(failed.status).toBe(503);
  expect(await failed.json()).toEqual({
    message: "掲示板を処理できませんでした。もう一度お試しください。",
  });
  await env.APP_DB.prepare("UPDATE board_settings SET accepting=0").run();
  const same = await submit(path + includeAttachments, user.headers, attachment, requestId);
  expect(same.status).toBe(200);
  expect(await same.json()).toEqual(initial);
  for (const changed of [
    undefined,
    { matchId, position: 1 },
    { matchId: crypto.randomUUID(), position: 0 },
  ])
    expect((await submit(path, user.headers, changed, requestId)).status).toBe(409);
  expect(await env.APP_DB.prepare("SELECT COUNT(*) AS n FROM board_posts").first("n")).toBe(1);
});

test("添付棋譜を読む前に受付停止、投稿停止、資格なし、返信先なしを返す", async () => {
  const { matchId } = await matchFixture();
  const user = await accountFixture();
  const stopped = { message: "現在、掲示板への投稿は停止されています。" };
  const missing = await submit(path, user.headers, { matchId: crypto.randomUUID(), position: 0 });
  expect(missing.status).toBe(403);
  expect(await missing.json()).toEqual(stopped);

  await env.APP_DB.prepare("DELETE FROM match_event_chunks WHERE match_id=?").bind(matchId).run();
  const attachment = { matchId, position: 0 };
  const closed = await submit(path, user.headers, attachment);
  expect(closed.status).toBe(403);
  expect(await closed.json()).toEqual(stopped);

  await openBoard();
  await env.APP_DB.prepare("INSERT INTO board_senders(account_id,stopped) VALUES(?,1)")
    .bind(user.id)
    .run();
  const suspended = await submit(path, user.headers, attachment);
  expect(suspended.status).toBe(403);
  expect(await suspended.json()).toEqual(stopped);
  const incomplete = await accountFixture(false);
  expect((await submit(path, incomplete.headers, attachment)).status).toBe(403);
  const eligible = await accountFixture();
  expect(
    (await submit(repliesPath(crypto.randomUUID()), eligible.headers, attachment)).status,
  ).toBe(404);
  expect(await env.APP_DB.prepare("SELECT COUNT(*) AS n FROM board_posts").first("n")).toBe(0);
});

test("削除された投稿の枠と削除された返信から添付を除く", async () => {
  await openBoard();
  const { matchId } = await matchFixture();
  const author = await accountFixture();
  const replier = await accountFixture();
  const attachment = { matchId, position: 0 };
  const { post } = boardPostResultSchema.parse(
    await (await submit(path, author.headers, attachment)).json(),
  );
  const { reply } = boardReplyResultSchema.parse(
    await (await submit(repliesPath(post!.id), replier.headers, attachment)).json(),
  );
  const surviving = await submit(repliesPath(post!.id), (await accountFixture()).headers);
  expect(surviving.status).toBe(200);
  for (const [id, headers] of [
    [post!.id, author.headers],
    [reply!.id, replier.headers],
  ] as const) {
    expect((await boardRequest(postPath(id), { method: "DELETE", headers })).status).toBe(204);
    expect(
      await env.APP_DB.prepare("SELECT match_id,position FROM board_posts WHERE id=?")
        .bind(id)
        .first(),
    ).toEqual({ match_id: null, position: null });
  }
  const thread = boardDetailSchema.parse(
    await (await boardRequest(postPath(post!.id) + includeAttachments)).json(),
  );
  expect(thread.post.status).toBe("deleted");
  expect(thread.post).not.toHaveProperty("attachment");
  expect(thread.replies).toHaveLength(1);
  expect(thread.replies[0]).toMatchObject({ attachment: null });
  const page = boardTimelineSchema.parse(
    await (await boardRequest(path + includeAttachments)).json(),
  );
  expect(page.posts[0]).toEqual(thread.post);
});
