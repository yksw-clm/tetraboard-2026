import { env } from "cloudflare:workers";
import { postChatMessage } from "@tetraboard/context-community";
import { expect, test } from "vitest";
import { D1ChatStore } from "../src/adapters/community/chatStore";
import { accountFixture } from "./accountFixtures";

test("本人確認の後に退会を受け付けた場合、新規投稿と受理済みIDの再送を拒否する", async () => {
  const db = env.APP_DB;
  const user = await accountFixture();
  const requestId = crypto.randomUUID();
  const now = Date.now();
  const store = new D1ChatStore(db);
  const post = (id: string, at: number) =>
    postChatMessage(
      store,
      { accountId: user.id, requestId: id, tournamentId: null, text: "発言" },
      () => at,
      async () => "hash",
    );
  expect((await post(requestId, now)).status).toBe("accepted");
  await db
    .prepare("INSERT INTO deleted_accounts(id,requested_at_ms,receipt_hash) VALUES(?,?,?)")
    .bind(user.id, now + 1, crypto.randomUUID())
    .run();

  const later = now + 10000;
  expect((await post(requestId, later)).status).toBe("rateLimited");
  expect((await post(crypto.randomUUID(), later)).status).toBe("rateLimited");
  const messages = await db
    .prepare("SELECT request_id FROM lobby_chat_messages WHERE account_id=?")
    .bind(user.id)
    .all<{ request_id: string }>();
  expect(messages.results).toEqual([{ request_id: requestId }]);
});
