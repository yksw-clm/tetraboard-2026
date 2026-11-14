import { expect, test } from "bun:test";
import { applyAction, getLegalMoves } from "@tetraboard/four-reversi";
import { WidgetController, type Reply } from "../src/controller";
import { observation, progressFor as responseFor, shogiObservation, settle } from "./fixtures";
import { type ContinuousRequest as AnalysisRequest } from "../src/model";
function harness() {
  const pending: { request: AnalysisRequest; resolve: (value: Reply) => void }[] = [];
  const messages: unknown[] = [];
  const callbacks: (() => void)[] = [];
  const servicePending: { command: string; resolve: (value: Reply) => void }[] = [];
  let changes = 0;
  const controller = new WidgetController(
    async (message) => {
      messages.push(message);
      const m = message as { type: string; request: AnalysisRequest };
      if (m.type === "service")
        return new Promise<Reply>((resolve) =>
          servicePending.push({ command: (message as { command: string }).command, resolve }),
        );
      if (m.type === "start") {
        const data = responseFor(m.request, 0);
        data.candidates = [];
        return { ok: true, data };
      }
      if (m.type === "poll") {
        const request = (
          messages.findLast((v) => (v as { type: string }).type === "start") as {
            request: AnalysisRequest;
          }
        ).request;
        return new Promise<Reply>((resolve) => pending.push({ request, resolve }));
      }
      return { ok: true };
    },
    () => {
      changes++;
    },
    "https://tetraboard.net/rooms/12345",
    async () => "a".repeat(64),
    async () => [],
    (callback) => {
      callbacks.push(callback);
      return () => {
        const index = callbacks.indexOf(callback);
        if (index >= 0) callbacks.splice(index, 1);
      };
    },
  );
  return {
    controller,
    callbacks,
    pending,
    messages,
    servicePending,
    get changes() {
      return changes;
    },
  };
}
test("AI停止は旧候補を捨て、停止中は自動探索せず、再起動後は本人手番を再検討する", async () => {
  const h = harness();
  h.controller.observe(observation());
  await h.controller.toggle();
  await settle();
  expect(h.pending).toHaveLength(1);
  const stopping = h.controller.controlService("stop");
  expect(h.controller.result).toBeNull();
  expect(h.controller.canAnalyze).toBe(false);
  h.pending[0].resolve({ ok: true, data: responseFor(h.pending[0].request) });
  h.servicePending[0].resolve({ ok: true, data: { state: "stopped" } });
  await stopping;
  h.controller.observe(observation());
  expect(h.controller.result).toBeNull();
  expect(h.pending).toHaveLength(1);
  const restarting = h.controller.controlService("restart");
  h.servicePending[1].resolve({ ok: true, data: { state: "running" } });
  await restarting;
  await settle();
  expect(h.pending).toHaveLength(2);
  expect(h.controller.canAnalyze).toBe(true);
  h.controller.stop();
});
test("遅い状態取得はAI起動後の状態を巻き戻さず、重複操作を送らない", async () => {
  const h = harness();
  const checking = h.controller.refreshService();
  const starting = h.controller.controlService("start");
  await h.controller.controlService("restart");
  expect(h.servicePending.map((p) => p.command)).toEqual(["status", "start"]);
  h.servicePending[1].resolve({ ok: true, data: { state: "running" } });
  await starting;
  h.servicePending[0].resolve({ ok: true, data: { state: "stopped" } });
  await checking;
  expect(h.controller.serviceState).toBe("running");
  expect(h.controller.enabled).toBe(false);
});
test("補助プログラムの導入前でも手動起動したAIで検討できる", async () => {
  const h = harness();
  const checking = h.controller.refreshService();
  h.servicePending[0].resolve({ ok: false, error: "setup:nativeを実行してください" });
  await checking;
  h.controller.observe(observation());
  await h.controller.toggle();
  await settle();
  expect(h.controller.serviceState).toBe("unavailable");
  expect(h.pending).toHaveLength(1);
  h.controller.stop();
});
test("同じ要求の探索進捗を蓄積表示し、2秒を超えて検討を続ける", async () => {
  const h = harness();
  h.controller.observe(observation());
  await h.controller.toggle();
  await settle();
  for (let i = 1; i <= 4; i++) {
    h.pending[i - 1].resolve({ ok: true, data: responseFor(h.pending[i - 1].request, i) });
    await settle();
    expect(h.controller.result?.sequence).toBe(i);
    expect(h.controller.busy).toBe(true);
    if (i < 4) {
      h.callbacks.shift()!();
      await settle();
    }
  }
  expect(h.messages.filter((m) => (m as { type: string }).type === "start")).toHaveLength(1);
  h.controller.stop();
  expect(h.callbacks).toHaveLength(0);
});
test("相手手番は自動解析せず、停止・非表示中の旧候補も表示しない", async () => {
  const h = harness(),
    o = observation();
  o.players[0].color = "white";
  h.controller.observe(o);
  await h.controller.toggle();
  await settle();
  expect(h.pending).toHaveLength(0);
  void h.controller.analyze();
  await settle();
  h.controller.stop();
  h.pending[0].resolve({ ok: true, data: responseFor(h.pending[0].request) });
  await settle();
  expect(h.controller.result).toBeNull();
  void h.controller.analyze();
  await settle();
  h.controller.setVisible(false);
  h.pending[1].resolve({ ok: true, data: responseFor(h.pending[1].request) });
  await settle();
  expect(h.controller.result).toBeNull();
});
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
  if (result.game !== "four-reversi") throw Error("fixture");
  result.candidates[0].position = { x: 3, y: 2 };
  h.pending[0].resolve({ ok: true, data: result });
  await settle();
  expect(h.controller.result).toBeNull();
  expect(h.controller.error).toContain("不正");
});

test("将棋も本人手番で継続検討し、revision変更で旧結果を破棄する", async () => {
  const h = harness(),
    o = shogiObservation();
  h.controller.observe(o);
  await h.controller.toggle();
  await settle();
  expect(h.pending[0].request.input.game).toBe("four-shogi");
  h.pending[0].resolve({ ok: true, data: responseFor(h.pending[0].request) });
  await settle();
  expect(h.controller.result?.game).toBe("four-shogi");
  h.controller.observe({ ...o, positionRevision: 1, serverNowMs: 101 });
  expect(h.controller.result).toBeNull();
  await settle();
  expect(h.pending).toHaveLength(2);
  h.controller.stop();
});
test("将棋の相手手番は手動だけ、本人脱落後とダブルスは検討しない", async () => {
  const h = harness(),
    o = shogiObservation();
  o.selfId = o.players[1].id;
  o.connectedPlayerIds = [o.selfId];
  h.controller.observe(o);
  await h.controller.toggle();
  await settle();
  expect(h.pending).toHaveLength(0);
  void h.controller.analyze();
  await settle();
  expect(h.pending).toHaveLength(1);
  if (!o.game) throw Error("fixture");
  o.game.eliminations = [{ side: "west", reason: "resigned", rank: 4, group: 0 }];
  h.controller.observe(structuredClone(o));
  expect(h.controller.canAnalyze).toBe(false);
  h.pending[0].resolve({ ok: true, data: responseFor(h.pending[0].request) });
  await settle();
  expect(h.controller.result).toBeNull();
  const doubles = shogiObservation();
  doubles.game!.mode = "doubles";
  h.controller.observe(doubles);
  expect(h.controller.canAnalyze).toBe(false);
});
test("同一探索の遅れたsequenceと停止後の進捗を表示しない", async () => {
  const h = harness();
  h.controller.observe(observation());
  await h.controller.toggle();
  await settle();
  h.pending[0].resolve({ ok: true, data: responseFor(h.pending[0].request, 2) });
  await settle();
  h.callbacks.shift()!();
  await settle();
  h.pending[1].resolve({ ok: true, data: responseFor(h.pending[1].request, 1) });
  await settle();
  expect(h.controller.result?.sequence).toBe(2);
  h.callbacks.shift()!();
  await settle();
  h.controller.stop();
  h.pending[2].resolve({ ok: true, data: responseFor(h.pending[2].request, 3) });
  await settle();
  expect(h.controller.result).toBeNull();
  expect(h.callbacks).toHaveLength(0);
});

test("将棋の同じ受信時刻でも古いrevisionへ戻らない", async () => {
  const h = harness(),
    o = shogiObservation();
  h.controller.observe({ ...o, positionRevision: 2 });
  await h.controller.toggle();
  await settle();
  h.controller.observe({ ...o, positionRevision: 1 });
  expect(
    h.controller.observation?.gameId === "four-shogi" && h.controller.observation.positionRevision,
  ).toBe(2);
  expect(h.pending).toHaveLength(1);
  h.controller.stop();
});
