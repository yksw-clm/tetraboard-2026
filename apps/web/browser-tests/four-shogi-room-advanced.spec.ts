import { expectReplaySelectFits } from "./replaySelectAssertions";
import { expect, test, type Page, type WebSocketRoute } from "@playwright/test";
import {
  applyAction,
  eliminateSide,
  getLegalActions,
  sides,
  type FourShogiState,
  type Piece,
} from "@tetraboard/four-shogi";
import {
  roomSocketContract,
  fourShogiRoomSchema,
  type FourShogiReplayEvent,
  type FourShogiReplayPage,
  type FourShogiRoom,
} from "@tetraboard/protocol";
import { membership, mockLobby, mockRoom, now, playerIds, token } from "./fixtures";
import {
  initialShogiState,
  playingShogiRoom,
  publicShogiState,
  shogiRoundId,
  tacticalShogiState,
  waitingShogiRoom,
} from "./fourShogiFixtures";

const square = (page: Page, name: string) =>
  page.getByTestId("shogi-board").locator(`[data-square="${name}"]`);
const gameActions = (received: { type: string }[]) =>
  received.filter((message) => message.type === "room.game.action");

// 観測対象の盤面・hookはそのまま使い、切断と再取得をHTTP/WS境界で制御します。
async function mockReconnectRoom(page: Page, initial: FourShogiRoom) {
  let room = initial;
  let presence = {
    hostPlayerId: playerIds[0]!,
    connectedPlayerIds: initial.players.map((p) => p.id),
  };
  let connections = 0;
  let roomGets = 0;
  const sockets = new Set<WebSocketRoute>();
  const received: ReturnType<typeof roomSocketContract.clientMessage.parse>[] = [];
  const snapshot = () => ({ room, presence, serverNowMs: now });
  const send = (socket: WebSocketRoute, message: unknown) =>
    socket.send(JSON.stringify(roomSocketContract.message.parse(message)));
  await page.clock.setFixedTime(now);
  await page.addInitScript(
    ({ value }) => {
      sessionStorage.setItem("tetraboard:room:12345:membership", value);
    },
    { value: token },
  );
  await page.route("**/api/account/session", (route) => route.fulfill({ json: { user: null } }));
  await page.route("**/api/rooms/12345", (route) => {
    roomGets++;
    return route.fulfill({ json: snapshot() });
  });
  await page.route("**/api/rooms/12345/me", (route) => route.fulfill({ json: membership }));
  await page.routeWebSocket("**/api/rooms/12345/ws?*", (socket) => {
    connections++;
    sockets.add(socket);
    socket.onClose(() => sockets.delete(socket));
    send(socket, { type: "room.snapshot", ...snapshot() });
    send(socket, { type: "room.chat.snapshot", messages: [] });
    socket.onMessage((raw) => {
      const message = roomSocketContract.clientMessage.parse(JSON.parse(String(raw)));
      received.push(message);
      if (message.type === "room.auth") send(socket, { type: "room.authenticated", membership });
    });
  });
  return {
    received,
    get connections() {
      return connections;
    },
    get roomGets() {
      return roomGets;
    },
    update(
      next: FourShogiRoom,
      connectedPlayerIds = next.players.map((p) => p.id),
      broadcast = true,
    ) {
      room = fourShogiRoomSchema.parse(next);
      presence = { ...presence, connectedPlayerIds };
      if (broadcast)
        for (const socket of sockets) send(socket, { type: "room.snapshot", ...snapshot() });
    },
    async disconnect() {
      await Promise.all(
        [...sockets].map((socket) => socket.close({ code: 1012, reason: "Fixture reconnect" })),
      );
      sockets.clear();
    },
  };
}

function restrictedCaptureState(prohibited: boolean): FourShogiState {
  const board: (Piece | null)[][] = Array.from({ length: 9 }, () => Array(9).fill(null));
  const pieces: [number, number, Piece["side"], Piece["kind"]][] = [
    [0, 8, "south", "king"],
    [0, 0, "west", "king"],
    [8, 0, "north", "king"],
    [8, 8, "east", "king"],
    [3, 5, "south", "rook"],
    [3, 2, "west", "gold"],
  ];
  pieces.forEach(([x, y, side, kind], index) => {
    board[y]![x] = { id: index + 1, side, kind, promoted: false };
  });
  return {
    ...initialShogiState(),
    board,
    nextPieceId: pieces.length + 1,
    repetitions: {},
    threePlayerAttackProhibited: prohibited,
    attackRelations: [
      {
        attacker: "north",
        target: "west",
        reasons: ["check"],
        targetPieceIds: [],
        pendingSides: ["south", "west", "east"],
      },
      {
        attacker: "east",
        target: "west",
        reasons: ["check"],
        targetPieceIds: [],
        pendingSides: ["south", "west", "north"],
      },
    ],
  };
}

test("三人攻撃ONは三人目の捕獲候補を除外し、OFFでは同じ駒を取れる", async ({ page }) => {
  const fixture = await mockRoom(page, playingShogiRoom(restrictedCaptureState(true)));
  await page.goto("/rooms/12345");
  const source = square(page, "D6"),
    target = square(page, "D3");
  await expect(source).toBeEnabled();
  await source.click();
  await expect(source).toHaveAttribute("aria-pressed", "true");
  await expect(target).toBeDisabled();
  expect(gameActions(fixture.received)).toHaveLength(0);
  fixture.update(playingShogiRoom(restrictedCaptureState(false), 1));
  await expect(page.getByText("三人攻撃禁止：OFF", { exact: true })).toBeVisible();
  await expect(source).toHaveAttribute("aria-pressed", "false");
  await source.click();
  await expect(target).toBeEnabled();
  await target.click();
  await page
    .getByRole("group", { name: "成りの選択" })
    .getByRole("button", { name: "成らない", exact: true })
    .click();
  await expect.poll(() => gameActions(fixture.received)).toHaveLength(1);
  expect(gameActions(fixture.received)[0]).toMatchObject({
    roundId: shogiRoundId,
    positionRevision: 1,
    action: { type: "movePiece", from: { x: 3, y: 5 }, to: { x: 3, y: 2 }, promote: false },
  });
});

test("同revisionの受信ではpendingを解除せず、再接続GETと認証後は最新局面へ戻る", async ({
  page,
}) => {
  const state = initialShogiState();
  const room = playingShogiRoom(state);
  const fixture = await mockReconnectRoom(page, room);
  await page.goto("/rooms/12345");
  const source = square(page, "E7");
  await expect(source).toBeEnabled();
  await source.click();
  await square(page, "E6").click();
  await expect.poll(() => gameActions(fixture.received)).toHaveLength(1);
  await expect(source).toBeDisabled();
  fixture.update(room, [playerIds[0]!, playerIds[2]!, playerIds[3]!]);
  const westCard = page.getByTestId("player-card").filter({ hasText: "参加者2" });
  await expect(westCard.getByLabel("切断中", { exact: true })).toBeVisible();
  await expect(source).toBeDisabled();
  await expect(square(page, "E6")).toBeDisabled();
  expect(gameActions(fixture.received)).toHaveLength(1);
  const moved = applyAction(state, "south", {
    type: "movePiece",
    from: { x: 4, y: 6 },
    to: { x: 4, y: 5 },
    promote: false,
  });
  if (!moved.ok) throw new Error("Invalid fixed reconnect move");
  fixture.update(
    playingShogiRoom(moved.state, 1),
    room.players.map((p) => p.id),
    false,
  );
  await fixture.disconnect();
  await expect.poll(() => fixture.connections).toBe(2);
  await expect.poll(() => fixture.roomGets).toBe(2);
  await expect.poll(() => fixture.received.filter((m) => m.type === "room.auth")).toHaveLength(2);
  await expect(square(page, "E7").getByTestId("shogi-piece")).toHaveCount(0);
  await expect(square(page, "E6")).toHaveAttribute("data-last-move", "to");
  await expect(page.getByText("参加者2の番です。", { exact: true })).toBeVisible();
  expect(gameActions(fixture.received)).toHaveLength(1);
});

test("送信待ち中に新局へ進むと旧局のpendingを解除し、新しい局IDで指せる", async ({ page }) => {
  const fixture = await mockRoom(page, playingShogiRoom());
  await page.goto("/rooms/12345");
  const source = square(page, "E7"),
    target = square(page, "E6");
  await expect(source).toBeEnabled();
  await source.click();
  await target.click();
  await expect.poll(() => gameActions(fixture.received)).toHaveLength(1);
  await expect(source).toBeDisabled();
  const next = playingShogiRoom();
  next.roundId = "00000000-0000-4000-8000-000000000021";
  fixture.update(next);
  await expect(source).toBeEnabled();
  await expect(source).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("shogi-board").locator("[data-legal-destination]")).toHaveCount(0);
  await source.click();
  await target.click();
  await expect.poll(() => gameActions(fixture.received)).toHaveLength(2);
  expect(gameActions(fixture.received)[0]).toMatchObject({
    roundId: shogiRoundId,
    positionRevision: 0,
  });
  expect(gameActions(fixture.received)[1]).toMatchObject({
    roundId: next.roundId,
    positionRevision: 0,
    action: { type: "movePiece", from: { x: 4, y: 6 }, to: { x: 4, y: 5 }, promote: false },
  });
});

test("選択中とドラッグ中のrevision更新は選択・候補・ghostを解除し、旧操作を送信しない", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 1000 });
  const state = tacticalShogiState();
  const fixture = await mockRoom(page, playingShogiRoom(state));
  await page.goto("/rooms/12345");
  const source = square(page, "E7"),
    target = square(page, "E6");
  await expect(source).toBeEnabled();
  await source.click();
  await expect(source).toHaveAttribute("aria-pressed", "true");
  await expect(target).toHaveAttribute("data-legal-destination", "true");
  fixture.update(playingShogiRoom(state, 1));
  await expect(source).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("shogi-board").locator("[data-legal-destination]")).toHaveCount(0);
  const a = (await source.boundingBox())!,
    b = (await target.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 5 });
  await expect(page.getByTestId("shogi-drag-ghost")).toBeVisible();
  fixture.update(playingShogiRoom(state, 2));
  await expect(page.getByTestId("shogi-drag-ghost")).toHaveCount(0);
  await expect(source).toHaveAttribute("aria-pressed", "false");
  await page.mouse.up();
  await expect(source).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("group", { name: "成りの選択" })).toHaveCount(0);
  expect(gameActions(fixture.received)).toHaveLength(0);
  await source.click();
  await target.click();
  await expect.poll(() => gameActions(fixture.received)).toHaveLength(1);
  expect(gameActions(fixture.received)[0]).toMatchObject({ positionRevision: 2 });
});

function pagedRound() {
  let state: FourShogiState = initialShogiState();
  let seed = 1;
  const events: FourShogiReplayPage["events"] = [];
  // 固定seedから100手を作る。アプリの応答や時計には依存しない棋譜データです。
  for (let index = 0; index < 100; index++) {
    if (state.status !== "playing") throw new Error("The fixed 100-move replay ended early");
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const legal = getLegalActions(state),
      action = legal[seed % legal.length]!;
    const event: FourShogiReplayEvent = { type: "action", side: state.turn, action };
    const moved = applyAction(state, state.turn, action);
    if (!moved.ok) throw new Error("Invalid fixed replay move");
    events.push({ index, event });
    state = moved.state;
  }
  for (const side of ["west", "north", "east"] as const) {
    const next = eliminateSide(state, side, "left");
    if (!next.ok) throw new Error("Invalid fixed replay elimination");
    events.push({ index: events.length, event: { type: "eliminate", side, reason: "left" } });
    state = next.state;
  }
  const game = publicShogiState(state);
  if (game.status !== "finished") throw new Error("Expected finished fixed replay");
  const room = waitingShogiRoom();
  room.lastRound = {
    roundId: shogiRoundId,
    game,
    players: sides.map((side, index) => ({
      id: playerIds[index]!,
      name: room.players[index]!.name,
      side,
    })),
    eventCount: events.length,
  };
  const initial = {
    mode: "singles" as const,
    players: initialShogiState().players,
    threePlayerAttackProhibited: true,
  };
  const page = (cursor = 0): FourShogiReplayPage => ({
    instanceId: room.instanceId,
    roundId: shogiRoundId,
    rulesVersion: 1,
    initial,
    eventCount: events.length,
    events: events.slice(cursor, cursor + 100),
    nextCursor: cursor + 100 < events.length ? cursor + 100 : null,
  });
  return { room, events, page };
}

test("100件ずつ取得する直前棋譜を最終局面から開始局面まで選べる", async ({ page }) => {
  const round = pagedRound();
  await mockRoom(page, round.room);
  const cursors: (string | null)[] = [];
  await page.route("**/api/rooms/12345/rounds/*/replay?*", (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("instanceId")).toBe(round.room.instanceId);
    cursors.push(url.searchParams.get("cursor"));
    return route.fulfill({ json: round.page(Number(url.searchParams.get("cursor") ?? 0)) });
  });
  await page.goto("/rooms/12345");
  const previous = page.getByRole("button", { name: "棋譜を1つ戻る" });
  await expect(previous).toBeEnabled();
  // StrictModeによる初回GETの取消と再取得は許容し、次のページへの進行を確認します。
  expect(cursors[0]).toBeNull();
  expect(cursors.filter((cursor) => cursor !== null)).toEqual(["100"]);
  await page.getByRole("button", { name: "棋譜の局面" }).click();
  await expectReplaySelectFits(page);
  await expect(page.getByRole("option")).toHaveCount(104);
  await page.getByRole("option", { name: "開始局面", exact: true }).click();
  await expect(previous).toBeDisabled();
  await expect(page.getByTestId("shogi-board").locator("[data-last-move]")).toHaveCount(0);
  await expect(square(page, "E7").getByTestId("shogi-piece")).toHaveCount(1);
});

test("後続ページの局ID・index・初期値の不一致は失敗表示にし、検証済み再取得で復帰する", async ({
  page,
}) => {
  const round = pagedRound();
  await mockRoom(page, round.room);
  let corruption: "round" | "index" | "initial" | null = "round";
  let attempts = 0;
  await page.route("**/api/rooms/12345/rounds/*/replay?*", (route) => {
    const cursor = Number(new URL(route.request().url()).searchParams.get("cursor") ?? 0);
    if (cursor === 0) attempts++;
    const data = round.page(cursor);
    if (cursor === 100) {
      if (corruption === "round") data.roundId = "00000000-0000-4000-8000-000000000099";
      if (corruption === "index")
        data.events = [{ ...data.events[0]!, index: 101 }, ...data.events.slice(1)];
      if (corruption === "initial")
        data.initial = { ...data.initial, threePlayerAttackProhibited: false };
    }
    return route.fulfill({ json: data });
  });
  await page.goto("/rooms/12345");
  const failure = page.getByRole("alert").filter({ hasText: "棋譜を取得できませんでした" });
  for (const next of ["index", "initial", null] as const) {
    await expect(failure).toBeVisible();
    await expect(page.getByRole("button", { name: "棋譜を1つ戻る" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "結果", exact: true })).toBeVisible();
    corruption = next;
    const before = attempts;
    await page.getByRole("button", { name: "再試行", exact: true }).click();
    await expect.poll(() => attempts).toBe(before + 1);
  }
  await expect(page.getByRole("button", { name: "棋譜を1つ戻る" })).toBeEnabled();
  await expect(failure).toHaveCount(0);
});

test("後続棋譜GETの途中で次局が始まるとabortし、遅い前局応答から戻らない", async ({ page }) => {
  const round = pagedRound();
  const fixture = await mockRoom(page, round.room);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requested: (string | null)[] = [];
  const aborted: string[] = [];
  let responded = false;
  page.on("requestfailed", (request) => {
    if (request.url().includes(`/rounds/${shogiRoundId}/replay`)) aborted.push(request.url());
  });
  await page.route("**/api/rooms/12345/rounds/*/replay?*", async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    requested.push(cursor);
    if (cursor === "100") await pending;
    try {
      await route.fulfill({ json: round.page(Number(cursor ?? 0)) });
    } finally {
      if (cursor === "100") responded = true;
    }
  });
  try {
    await page.goto("/rooms/12345");
    await expect.poll(() => requested.includes("100")).toBe(true);
    expect(requested[0]).toBeNull();
    expect(requested.filter((cursor) => cursor !== null)).toEqual(["100"]);
    const next = playingShogiRoom();
    next.roundId = "00000000-0000-4000-8000-000000000021";
    fixture.update(next);
    await expect(square(page, "E7")).toBeEnabled();
    await expect(page.getByText("棋譜を読み込んでいます…", { exact: true })).toHaveCount(0);
    await expect
      .poll(() => aborted.some((url) => new URL(url).searchParams.get("cursor") === "100"))
      .toBe(true);
    release();
    await expect.poll(() => responded).toBe(true);
    await expect(page.getByRole("button", { name: "棋譜を1つ戻る" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "結果", exact: true })).toHaveCount(0);
    await expect(square(page, "E7").getByTestId("shogi-piece")).toHaveCount(1);
    await expect(square(page, "E6").getByTestId("shogi-piece")).toHaveCount(0);
    expect(gameActions(fixture.received)).toHaveLength(0);
  } finally {
    release();
  }
});

for (const game of ["four-reversi", "four-shogi"] as const) {
  test(`${game}のEnter送信失敗後は入力へフォーカスが戻り、Escapeで閉じられる`, async ({ page }) => {
    await mockLobby(page);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/rooms", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      await pending;
      await route.fulfill({ status: 503, json: { error: "internal_error" } });
    });
    try {
      await page.goto(`/games/${game}`);
      const trigger = page.getByRole("button", { name: /^すぐ遊ぶ/ });
      await trigger.focus();
      await expect(trigger).toBeFocused();
      await trigger.press("Enter");
      const dialog = page.getByRole("dialog", { name: "すぐ遊ぶ", exact: true });
      const nickname = dialog.getByRole("textbox", { name: "ニックネーム", exact: true });
      await nickname.fill("入力を保持");
      await nickname.press("Enter");
      await expect(dialog.getByRole("button", { name: "閉じる", exact: true })).toBeDisabled();
      release();
      await expect(dialog.getByRole("alert")).toBeVisible();
      await expect(
        dialog.getByRole("button", { name: "CPUとの待機室へ", exact: true }),
      ).toBeEnabled();
      await expect(nickname).toBeFocused();
      await expect(nickname).toHaveValue("入力を保持");
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(trigger).toBeFocused();
    } finally {
      release();
    }
  });
}
