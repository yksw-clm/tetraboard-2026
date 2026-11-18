import { expect, test } from "bun:test";
import type { AnnouncementRecord } from "@tetraboard/protocol";
import {
  listAnnouncements,
  readAnnouncement,
  readLobbyAnnouncement,
  updateAnnouncement,
  type AnnouncementQueries,
} from "@tetraboard/context-community";

const draft: AnnouncementRecord = {
  id: "draft",
  title: "下書き",
  body: "一行目\n二行目",
  date: "2026-11-18",
  kind: "improvement",
  published: false,
  createdAtMs: 10,
  updatedAtMs: 11,
  version: 2,
  lobbyGames: ["four-reversi"],
};
const published = { ...draft, id: "published", title: "公開記事", published: true };
const position = (row: AnnouncementRecord) => ({ date: row.date, at: row.createdAtMs, id: row.id });
const firstLine = (body: string) => body.split("\n")[0]!;

test("公開一覧は20件を要約し、最後に表示した行の位置を次のカーソルにする", async () => {
  const records = Array.from({ length: 21 }, (_, index) => ({
    ...published,
    id: String(99 - index),
  }));
  const after = { date: draft.date, at: 15, id: "previous" };
  const page = await listAnnouncements(
    {
      async list(publishedOnly, cursor, take) {
        expect(cursor).toEqual(after);
        return (publishedOnly ? records : [draft, ...records]).slice(0, take);
      },
      position,
      record: (item) => item,
    },
    "public",
    after,
    firstLine,
  );

  expect(page.announcements).toHaveLength(20);
  expect(page.announcements[0]).toEqual({
    id: "99",
    title: published.title,
    date: published.date,
    kind: published.kind,
    summary: "一行目",
  });
  expect(page.nextCursor).toEqual({ date: published.date, at: published.createdAtMs, id: "80" });
});

test("管理一覧は非公開記事の版と掲載先を含め、50件ちょうどなら続きがない", async () => {
  const records = [
    draft,
    ...Array.from({ length: 49 }, (_, index) => ({ ...published, id: String(index) })),
  ];
  const page = await listAnnouncements(
    {
      list: async (publishedOnly, _after, take) =>
        (publishedOnly ? records.slice(1) : records).slice(0, take),
      position,
      record: (item) => item,
    },
    "admin",
    undefined,
    firstLine,
  );

  expect(page.announcements).toHaveLength(50);
  expect(page.announcements[0]).toEqual(draft);
  expect(page.nextCursor).toBeNull();
});

const queries: Pick<
  AnnouncementQueries<AnnouncementRecord>,
  "read" | "record" | "latestPublishedForLobby"
> = {
  read: async (id, publishedOnly) =>
    [draft, published].find((record) => record.id === id && (!publishedOnly || record.published)) ??
    null,
  record: (item) => item,
  latestPublishedForLobby: async (game) => (published.lobbyGames.includes(game) ? published : null),
};

test("公開詳細は下書きを返さない", async () => {
  expect(await readAnnouncement(queries, draft.id, "public")).toBeNull();
});

test("ロビーには掲載対象の公開記事を要約して返す", async () => {
  expect(await readLobbyAnnouncement(queries, "four-reversi", firstLine)).toEqual({
    id: published.id,
    title: published.title,
    date: published.date,
    kind: published.kind,
    summary: "一行目",
  });
});

test("古い版の編集は最新の版で上書きされず、競合になる", async () => {
  let saved = draft;
  const result = await updateAnnouncement(
    {
      ...queries,
      read: async () => saved,
      create: async () => {
        throw new Error("unexpected create");
      },
      async update(_id, input, version) {
        if (saved.version !== version) return false;
        saved = { ...saved, ...input, version: version + 1 };
        return true;
      },
    },
    draft.id,
    { ...draft, version: 1, lobbyGames: [] },
  );

  expect(result).toEqual({ status: "conflict" });
  expect(saved).toEqual(draft);
});
