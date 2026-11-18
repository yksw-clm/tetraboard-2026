import type { AnnouncementInput, AnnouncementRecord } from "@tetraboard/protocol";
import {
  announcementDetail,
  type AnnouncementCursor,
  type AnnouncementScope,
} from "../domain/announcements";

export interface AnnouncementQueries<Row> {
  list(publishedOnly: boolean, after: AnnouncementCursor | undefined, take: number): Promise<Row[]>;
  read(id: string, publishedOnly: boolean): Promise<Row | null>;
  latestPublishedForLobby(game: AnnouncementInput["lobbyGames"][number]): Promise<Row | null>;
  position(row: Row): AnnouncementCursor;
  record(row: Row): AnnouncementRecord;
}

export interface AnnouncementWrites {
  create(input: AnnouncementInput): Promise<string>;
  update(id: string, input: AnnouncementInput, version: number): Promise<boolean>;
}

function summarize(record: AnnouncementRecord, firstLine: (body: string) => string) {
  const { body, ...value } = announcementDetail(record);
  return { ...value, summary: firstLine(body) };
}

export async function listAnnouncements<Row>(
  store: Pick<AnnouncementQueries<Row>, "list" | "position" | "record">,
  scope: AnnouncementScope,
  after: AnnouncementCursor | undefined,
  firstLine: (body: string) => string,
) {
  const publishedOnly = scope === "public";
  const limit = publishedOnly ? 20 : 50;
  const rows = await store.list(publishedOnly, after, limit + 1);
  return {
    announcements: rows.slice(0, limit).map((row) => {
      const record = store.record(row);
      return publishedOnly ? summarize(record, firstLine) : record;
    }),
    nextCursor: rows.length > limit ? store.position(rows[limit - 1]!) : null,
  };
}

export async function readAnnouncement<Row>(
  store: Pick<AnnouncementQueries<Row>, "read" | "record">,
  id: string,
  scope: AnnouncementScope,
) {
  const publishedOnly = scope === "public";
  const row = await store.read(id, publishedOnly);
  if (!row) return null;
  const record = store.record(row);
  return publishedOnly ? announcementDetail(record) : record;
}

export async function readLobbyAnnouncement<Row>(
  store: Pick<AnnouncementQueries<Row>, "latestPublishedForLobby" | "record">,
  game: AnnouncementInput["lobbyGames"][number],
  firstLine: (body: string) => string,
) {
  const row = await store.latestPublishedForLobby(game);
  return row ? summarize(store.record(row), firstLine) : null;
}

type AnnouncementEditor<Row> = AnnouncementWrites &
  Pick<AnnouncementQueries<Row>, "read" | "record">;

async function savedAnnouncement<Row>(store: AnnouncementEditor<Row>, id: string) {
  const row = await store.read(id, false);
  if (!row) throw new Error("Saved announcement missing");
  return store.record(row);
}

export async function createAnnouncement<Row>(
  store: AnnouncementEditor<Row>,
  input: AnnouncementInput,
) {
  return savedAnnouncement(store, await store.create(input));
}

export async function updateAnnouncement<Row>(
  store: AnnouncementEditor<Row>,
  id: string,
  input: AnnouncementInput & { version: number },
) {
  if (!(await store.read(id, false))) return { status: "not_found" } as const;
  if (!(await store.update(id, input, input.version))) return { status: "conflict" } as const;
  return { status: "updated", announcement: await savedAnnouncement(store, id) } as const;
}
