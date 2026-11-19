import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, expect, vi } from "vitest";
import { createRoomContract, type GameId, type RoomPublicMetadata } from "@tetraboard/protocol";
import { gameCatalog } from "@tetraboard/protocol/games";
import { lobbyRoomCardsSchema } from "@tetraboard/protocol/general-lobby";
import worker from "../src/worker";
import { type PendingRoomIndex } from "../src/adapters/room/roomIndexWrite";
import { accountFixture, origin } from "./accountFixtures";
import { boundaryRequest, RoomBoundaryFixtures } from "./roomBoundaryFixtures";

export const db = (env as typeof env & { LOBBY_ROOM_CARDS_TEST_DB: D1Database })
  .LOBBY_ROOM_CARDS_TEST_DB;

export let fixtures: RoomBoundaryFixtures;

export const entries: ReturnType<typeof createRoomContract.response.parse>[] = [];

export const request = (suffix = "", database = db) =>
  worker.fetch(
    new Request(`${origin}/api/lobby/rooms${suffix}`),
    { ...env, APP_DB: database },
    {} as ExecutionContext,
  );

export async function cards(suffix = "", database = db) {
  const response = await request(`?view=cards${suffix}`, database);
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  return lobbyRoomCardsSchema.parse(await response.json());
}

export function indexed(id: number, game: GameId, rank = 0): PendingRoomIndex {
  const capacity = gameCatalog[game].capacity;
  const metadata: RoomPublicMetadata = {
    id: String(id),
    game,
    ...(gameCatalog[game].hasModes
      ? { mode: id % 2 ? ("singles" as const) : ("doubles" as const) }
      : {}),
    timeControl: { mainTimeMs: 300000, byoyomiMs: 30000 },
    status: rank === 2 ? "playing" : "waiting",
    hostName: "同じ名前",
    hostAvatarUrl: null,
    humanCount: rank === 0 ? 1 : capacity,
    cpuCount: 0,
    capacity,
    openSeats: rank === 0 ? capacity - 1 : 0,
    updatedAtMs: 1000,
  };
  return {
    revision: 1,
    closed: false,
    retryAtMs: 0,
    metadata: {
      ...metadata,
      instanceId: crypto.randomUUID(),
      hostPlayerId: crypto.randomUUID(),
      participantPreviews: Array.from({ length: metadata.humanCount }, () => ({
        playerId: crypto.randomUUID(),
        appearance: { kind: "human" as const, avatarUrl: null },
      })),
    },
  };
}

export async function accountRoom() {
  const user = await accountFixture();
  const avatarId = crypto.randomUUID();
  await env.APP_DB.prepare("UPDATE user SET avatarKey=? WHERE id=?")
    .bind(`avatars/${avatarId}.webp`, user.id)
    .run();
  const response = await boundaryRequest("/rooms", {
    method: "POST",
    headers: user.headers,
    body: JSON.stringify({ quickPlay: false, mode: "singles" }),
  });
  expect(response.status).toBe(201);
  const entry = createRoomContract.response.parse(await response.json());
  entries.push(entry);
  return { user, avatarId, entry, stub: env.GAME_ROOM.getByName(entry.room.id) };
}

export async function waitForIndex(
  id: string,
  predicate: (row: {
    revision: number;
    participants_json: string | null;
    updated_at_ms: number;
  }) => boolean,
) {
  let result!: { revision: number; participants_json: string | null; updated_at_ms: number };
  await vi.waitFor(async () => {
    const row = await env.APP_DB.prepare(
      "SELECT revision,participants_json,updated_at_ms FROM room_index WHERE room_id=?",
    )
      .bind(id)
      .first<typeof result>();
    expect(row && predicate(row)).toBeTruthy();
    result = row!;
  });
  return result;
}

export function registerLobbyRoomCardsFixtures() {
  beforeEach(() => {
    fixtures = new RoomBoundaryFixtures();
  });
  beforeAll(async () => {
    await applyD1Migrations(
      db,
      (
        env as typeof env & {
          TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
        }
      ).TEST_MIGRATIONS,
    );
  });
  afterEach(async () => {
    for (const entry of entries.splice(0).reverse()) {
      expect(
        (
          await boundaryRequest(`/rooms/${entry.room.id}/leave`, {
            method: "POST",
            headers: { Authorization: `Bearer ${entry.membership.token}`, Origin: origin },
          })
        ).status,
      ).toBe(204);
    }
    await fixtures.dispose();
    await db.batch(
      [
        "room_index",
        "privacy_room_accounts",
        "privacy_room_players",
        "deletion_rooms",
        "deleted_accounts",
        "guest_account_merges",
        "guest_oauth_flows",
        "guest_sessions",
        "legal_consents",
        "session",
        "user",
      ].map((table) => db.prepare(`DELETE FROM ${table}`)),
    );
  });
}
