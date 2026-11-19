import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect } from "vitest";
import { gameCatalog, type GameId } from "@tetraboard/protocol/games";
import { accountIdentity } from "../src/adapters/account/auth";
import { reserveAccountSeat } from "../src/flows/accountSeats/reserve";
import { accountFixture, origin } from "./accountFixtures";
import { boundaryRequest, RoomBoundaryFixtures, type BoundarySocket } from "./roomBoundaryFixtures";

export async function digest(token: string) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)))]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
}

export function useGuestRegistrationRooms() {
  let fixtures: RoomBoundaryFixtures;

  beforeEach(() => {
    fixtures = new RoomBoundaryFixtures();
  });

  afterEach(async () => {
    await fixtures.dispose();
  });

  async function addPlayersAndStart(
    entry: Awaited<ReturnType<RoomBoundaryFixtures["create"]>>,
    host: BoundarySocket,
    game: GameId,
  ) {
    const others = [];
    const clients = [host];
    for (let index = 1; index < gameCatalog[game].capacity; index++) {
      const other = await fixtures.join(entry.room.id, `参加${index}`);
      others.push(other);
      clients.push(await fixtures.connect(other));
    }
    for (const client of clients) client.send({ type: "room.ready.set", ready: true });
    await host.waitFor("room.snapshot", (message) => message.room.players.every((p) => p.ready));
    host.send({ type: "room.game.start" });
    await host.waitFor("room.snapshot", (message) => message.room.status === "playing");
    return others;
  }

  async function finish(
    entry: Awaited<ReturnType<RoomBoundaryFixtures["create"]>>,
    host: BoundarySocket,
    others: Awaited<ReturnType<RoomBoundaryFixtures["create"]>>[],
  ) {
    for (const other of others) {
      const response = await boundaryRequest(`/rooms/${entry.room.id}/leave`, {
        method: "POST",
        headers: { Authorization: `Bearer ${other.membership.token}`, Origin: origin },
      });
      expect(response.status).toBe(204);
      fixtures.forgetDepartedPlayer(other.membership.playerId);
    }
    return (await host.waitFor("room.snapshot", (message) => message.room.lastRound !== null)).room;
  }

  async function setup(game: GameId = "reversi") {
    const entry = await fixtures.create({
      name: "ゲスト本人",
      game,
      quickPlay: false,
      ...(gameCatalog[game].hasModes ? { mode: "singles" } : {}),
    });
    const host = await fixtures.connect(entry);
    const others = await addPlayersAndStart(entry, host, game);
    const room = await finish(entry, host, others);
    const last = room.lastRound!;
    const matchId = "roundId" in last ? last.roundId : last.replay!.id;
    const nextToken = "ab".repeat(32);
    const input = {
      registrationId: crypto.randomUUID(),
      instanceId: room.instanceId,
      matchId,
      oldTokenHash: await digest(entry.membership.token),
      newTokenHash: await digest(nextToken),
    };
    const stub = env.GAME_ROOM.getByName(entry.room.id);
    return { entry, host, room, stub, input, nextToken };
  }

  async function admission(prepared: Awaited<ReturnType<typeof setup>>) {
    const user = await accountFixture();
    const request = new Request(`${origin}/api/rooms`, { headers: user.headers });
    const profile = await accountIdentity(request, env);
    const seat = await reserveAccountSeat(
      request,
      env,
      profile!,
      prepared.room,
      prepared.entry.membership.playerId,
      { reuseForGuestRegistration: true },
    );
    return { user, request, profile: profile!, seat };
  }

  return { rooms: () => fixtures, setup, addPlayersAndStart, finish, admission };
}
