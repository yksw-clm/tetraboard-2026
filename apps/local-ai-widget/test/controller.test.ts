import { expect, test } from "bun:test";
import { applyAction, getLegalMoves } from "@tetraboard/four-reversi";
import { WidgetController, type Reply } from "../src/controller";
import { observation, responseFor, settle } from "./fixtures";
import { type AnalysisRequest } from "../src/model";
function harness() {
  const pending: { request: AnalysisRequest; resolve: (value: Reply) => void }[] = [];
  const messages: unknown[] = [];
  let changes = 0;
  const controller = new WidgetController(
    async (message) => {
      messages.push(message);
      const m = message as { type: string; request: AnalysisRequest };
      if (m.type === "analyze")
        return new Promise<Reply>((resolve) => pending.push({ request: m.request, resolve }));
      return { ok: true };
    },
    () => {
      changes++;
    },
    "https://tetraboard.net/rooms/12345",
    async () => "a".repeat(64),
  );
  return {
    controller,
    pending,
    messages,
    get changes() {
      return changes;
    },
  };
}
test("初期は無効、有効化後の本人手番だけ自動解析し時計更新で再実行しない", async () => {
  const h = harness(),
    o = observation();
  h.controller.observe(o);
  expect(h.pending).toHaveLength(0);
  await h.controller.toggle();
  await settle();
  expect(h.pending).toHaveLength(1);
  h.pending[0].resolve({ ok: true, data: responseFor(h.pending[0].request) });
  await settle();
  expect(h.controller.result).not.toBeNull();
  const renders = h.changes;
  h.controller.observe({ ...o, serverNowMs: 200 });
  await settle();
  expect(h.pending).toHaveLength(1);
  expect(h.changes).toBe(renders);
});
test("相手の手番は手動解析でき、失敗後も再試行できる", async () => {
  const h = harness(),
    o = observation();
  o.players[0].color = "white";
  h.controller.observe(o);
  await h.controller.toggle();
  await settle();
  expect(h.pending).toHaveLength(0);
  void h.controller.analyze();
  await settle();
  h.pending[0].resolve({ ok: false, error: "ローカルAIが停止しています" });
  await settle();
  expect(h.controller.error).toContain("停止");
  expect(h.controller.busy).toBe(false);
  void h.controller.analyze();
  await settle();
  expect(h.pending).toHaveLength(2);
  h.pending[1].resolve({ ok: true, data: responseFor(h.pending[1].request) });
  await settle();
  expect(h.controller.result).not.toBeNull();
});
test("着手後に旧応答が届いても表示せず、相手手番の候補を自動生成しない", async () => {
  const h = harness(),
    o = observation();
  h.controller.observe(o);
  await h.controller.toggle();
  await settle();
  const move = getLegalMoves(o.game!)[0];
  const next = applyAction(o.game!, { type: "placeStone", position: move });
  if (!next.ok) throw Error("fixture");
  h.controller.observe({
    ...o,
    game: next.state as typeof o.game,
    turnStartedAt: 200,
    serverNowMs: 200,
  });
  h.pending[0].resolve({ ok: true, data: responseFor(h.pending[0].request) });
  await settle();
  expect(h.controller.result).toBeNull();
  expect(h.controller.busy).toBe(false);
  expect(h.pending).toHaveLength(1);
});
for (const reason of ["切断", "待機", "本人変更", "ルーム移動", "タブ非表示", "別タブで有効化"]) {
  test(`${reason}で解析を無効化し遅延応答を捨てる`, async () => {
    const h = harness(),
      o = observation();
    h.controller.observe(o);
    await h.controller.toggle();
    await settle();
    if (reason === "切断") h.controller.observe({ ...o, connected: false, selfId: null });
    if (reason === "待機")
      h.controller.observe({ ...o, status: "waiting", game: null, turnStartedAt: null });
    if (reason === "本人変更") h.controller.observe({ ...o, selfId: null });
    if (reason === "ルーム移動") h.controller.navigate("https://tetraboard.net/rooms/54321");
    if (reason === "タブ非表示") h.controller.setVisible(false);
    if (reason === "別タブで有効化") h.controller.revoke();
    h.pending[0].resolve({ ok: true, data: responseFor(h.pending[0].request) });
    await settle();
    expect(h.controller.result).toBeNull();
    expect(h.controller.busy).toBe(false);
    expect(h.messages).toContainEqual({ type: "cancel" });
  });
}
test("停止後の同一局面では再起動せず、復帰は最新受信を待つ", async () => {
  const h = harness(),
    o = observation();
  h.controller.observe(o);
  await h.controller.toggle();
  await settle();
  h.controller.stop();
  h.controller.observe({ ...o, serverNowMs: 101 });
  await settle();
  expect(h.pending).toHaveLength(1);
  h.controller.setVisible(false);
  h.controller.setVisible(true);
  expect(h.controller.canAnalyze).toBe(false);
  h.controller.observe({ ...o, serverNowMs: 102, generation: 2 });
  await settle();
  expect(h.pending).toHaveLength(2);
});
test("手番外の脱落と次局で旧結果を破棄し再解析する", async () => {
  const h = harness(),
    o = observation();
  h.controller.observe(o);
  await h.controller.toggle();
  await settle();
  const eliminated = structuredClone(o);
  eliminated.game!.eliminatedColors = ["blue"];
  h.controller.observe(eliminated);
  await settle();
  expect(h.pending).toHaveLength(2);
  h.pending[0].resolve({ ok: true, data: responseFor(h.pending[0].request) });
  await settle();
  expect(h.controller.result).toBeNull();
  h.controller.observe({ ...o, status: "waiting", game: null });
  h.controller.observe({ ...o, turnStartedAt: 300, serverNowMs: 300 });
  await settle();
  expect(h.pending).toHaveLength(3);
});
test("本人の在室が消えたら同じ盤面でも結果を消す", async () => {
  const h = harness(),
    o = observation();
  h.controller.observe(o);
  await h.controller.toggle();
  await settle();
  h.pending[0].resolve({ ok: true, data: responseFor(h.pending[0].request) });
  await settle();
  h.controller.observe({ ...o, connectedPlayerIds: [] });
  expect(h.controller.result).toBeNull();
  expect(h.controller.canAnalyze).toBe(false);
});
test("不正な解析応答は参考値として表示しない", async () => {
  const h = harness();
  h.controller.observe(observation());
  await h.controller.toggle();
  await settle();
  const result = responseFor(h.pending[0].request);
  result.candidates[0].position = { x: 3, y: 2 };
  h.pending[0].resolve({ ok: true, data: result });
  await settle();
  expect(h.controller.result).toBeNull();
  expect(h.controller.error).toContain("不正");
});
