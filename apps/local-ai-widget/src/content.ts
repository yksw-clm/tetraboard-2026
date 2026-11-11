import {
  channel,
  observationSchema,
  roomIdFromUrl,
  eligible,
  colorNames,
  sideNames,
} from "./model";
import { paintOverlay } from "./overlay";
import { WidgetController, type Reply } from "./controller";
import { shogiCandidateLabel } from "./presentation";
let collapsed = false;
let overlayError = "";
const controller = new WidgetController(
  send,
  () => {
    render();
    draw();
  },
  location.href,
);
const host = document.createElement("div"),
  overlay = document.createElement("div");
host.id = "tetraboard-local-ai-widget";
overlay.id = "tetraboard-local-ai-candidates";
Object.assign(host.style, {
  position: "fixed",
  right: "12px",
  top: "72px",
  width: "min(320px,calc(100vw - 24px))",
  zIndex: "2147483646",
});
Object.assign(overlay.style, {
  position: "fixed",
  inset: "0",
  pointerEvents: "none",
  zIndex: "2147483645",
});
overlay.setAttribute("aria-hidden", "true");
const shadow = host.attachShadow({ mode: "closed" });
const style = document.createElement("style");
style.textContent =
  ":host{font:14px/1.5 sans-serif;color:#e9f5ec}article{background:#18392ff5;border:1px solid #7b9c89;border-radius:12px;box-shadow:0 4px 16px #0005;overflow:hidden}header{display:flex;align-items:center;justify-content:space-between;padding:8px 12px;cursor:move;touch-action:none}section{padding:0 12px 12px;max-height:55vh;overflow:auto}button{background:#e2eedc;color:#143021;border:0;border-radius:6px;padding:7px 10px;margin:3px;cursor:pointer}button:disabled{opacity:.5;cursor:default}p{margin:8px 0}ol{padding-left:24px}small{color:#c4d7cb}h2{font-size:14px;margin:0}";
const card = document.createElement("article"),
  header = document.createElement("header"),
  title = document.createElement("h2"),
  fold = document.createElement("button"),
  section = document.createElement("section");
title.textContent = "TetraBoard ローカルAI";
header.append(title, fold);
card.append(header, section);
shadow.append(style, card);
fold.addEventListener("click", () => {
  collapsed = !collapsed;
  render();
});
const enableButton = document.createElement("button"),
  analyzeButton = document.createElement("button"),
  stopButton = document.createElement("button"),
  details = document.createElement("div");
enableButton.addEventListener("click", () => {
  void controller.toggle();
});
analyzeButton.textContent = "解析・再解析";
analyzeButton.addEventListener("click", () => {
  void controller.analyze();
});
stopButton.textContent = "停止";
stopButton.addEventListener("click", () => {
  controller.stop();
});
section.append(enableButton, analyzeButton, stopButton, details);
async function send(message: unknown): Promise<Reply> {
  const response = await chrome.runtime.sendMessage(message);
  if (!response || typeof response.ok !== "boolean")
    throw Error("拡張への接続が切れました。ページを再読み込みしてください");
  return response;
}
function paragraph(text: string) {
  const p = document.createElement("p");
  p.textContent = text;
  details.append(p);
  return p;
}
function render() {
  const { enabled, observation, busy, result, error } = controller;
  host.hidden = !roomIdFromUrl(location.href);
  fold.textContent = collapsed ? "開く" : "折り畳む";
  section.hidden = collapsed;
  enableButton.textContent = enabled ? "無効にする" : "有効にする";
  enableButton.disabled = controller.switching;
  analyzeButton.disabled = !controller.canAnalyze || busy;
  stopButton.disabled = !busy;
  details.replaceChildren();
  if (!enabled) {
    paragraph(error || "このタブでは無効です");
    return;
  }
  if (error) paragraph(error).setAttribute("role", "status");
  if (overlayError) paragraph(overlayError).setAttribute("role", "status");
  if (!eligible(observation)) {
    paragraph("参加中の四人リバーシ・四人将棋シングルスの受信を待っています");
    return;
  }
  const turnName =
    observation.gameId === "four-reversi"
      ? colorNames[observation.game.turn]
      : sideNames[observation.game.turn];
  paragraph(
    `${observation.gameId === "four-reversi" ? "四人リバーシ" : "四人将棋"} 継続検討AI · ${turnName}の候補手 · ${observation.game.moveNumber}手目`,
  );
  if (busy) paragraph("検討中… 着手するまで探索を続けます");
  if (!result) return;
  const list = document.createElement("ol");
  if (result.game === "four-reversi") {
    for (const c of result.candidates) {
      const li = document.createElement("li");
      li.textContent = `${"ABCDEFGH"[c.position.x]}${c.position.y + 1} · ${c.visits}回`;
      list.append(li);
    }
    details.append(list);
    const top = result.candidates[0];
    if (top) {
      paragraph("推奨手後の探索内・単独1位率");
      paragraph(
        top.solo_wins
          .map((n, i) => `${["黒", "白", "赤", "青"][i]} ${((n / top.visits) * 100).toFixed(1)}%`)
          .join(" / "),
      );
    } else paragraph("評価未取得：完走した探索がありません");
    paragraph(`${result.diagnostics.trials ?? 0}試行 / ${result.diagnostics.nodes ?? 0}着手適用`);
    paragraph(
      "探索内の参考値です。対人勝率ではありません。同率1位を含まず、合計100%にならない場合があります。",
    );
  } else if (observation.gameId === "four-shogi") {
    for (const c of result.candidates) {
      const li = document.createElement("li");
      li.textContent = `${shogiCandidateLabel(c.action, observation)} · 参考評価 ${c.score.toFixed(0)}`;
      list.append(li);
    }
    details.append(list);
    paragraph(
      `完了深さ ${result.diagnostics.completed_depth ?? 0} / ${result.diagnostics.nodes ?? 0}探索局面`,
    );
    paragraph(
      "手番の陣営から見た参考評価です。勝率ではありません。矢印は移動元から移動先、駒打ちは移動先の番号で示します。",
    );
  }
}
function draw() {
  const { result, observation, enabled } = controller;
  if (!result || !observation || !enabled || document.hidden) {
    overlay.replaceChildren();
    if (overlayError) {
      overlayError = "";
      render();
    }
    return;
  }
  const nextError = paintOverlay(overlay, observation, result)
    ? ""
    : "盤面の位置を確認できないため、候補番号を非表示にしました";
  if (overlayError !== nextError) {
    overlayError = nextError;
    render();
  }
}

window.addEventListener("message", (event) => {
  if (
    event.source !== window ||
    event.origin !== location.origin ||
    event.data?.channel !== channel ||
    event.data.type !== "observation"
  )
    return;
  const parsed = observationSchema.safeParse(event.data.data);
  if (!parsed.success || parsed.data.roomId !== roomIdFromUrl(location.href)) return;
  controller.observe(parsed.data);
});
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "revoked") controller.revoke();
});
document.addEventListener("visibilitychange", () => {
  controller.setVisible(!document.hidden);
  if (!document.hidden) window.postMessage({ channel, type: "request" }, location.origin);
});
let path = location.pathname;
let pendingDraw = false;
function schedule() {
  if (pendingDraw) return;
  pendingDraw = true;
  requestAnimationFrame(() => {
    pendingDraw = false;
    if (path !== location.pathname) {
      path = location.pathname;
      controller.navigate(location.href);
      window.postMessage({ channel, type: "request" }, location.origin);
      render();
    }
    clampPosition();
    draw();
  });
}
function mount() {
  if (!document.body) return;
  document.body.append(host, overlay);
  new MutationObserver((records) => {
    if (
      records.some(
        (r) =>
          r.target !== overlay &&
          !overlay.contains(r.target) &&
          r.target !== host &&
          !host.contains(r.target),
      )
    )
      schedule();
  }).observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["aria-label", "class", "hidden", "style"],
  });
  new ResizeObserver(schedule).observe(document.body);
  controller.setVisible(!document.hidden);
  window.postMessage({ channel, type: "request" }, location.origin);
}
window.addEventListener("scroll", schedule, true);
window.addEventListener("resize", schedule);
window.visualViewport?.addEventListener("resize", schedule);
window.visualViewport?.addEventListener("scroll", schedule);
if (document.body) mount();
else document.addEventListener("DOMContentLoaded", mount, { once: true });
let drag: { x: number; y: number; left: number; top: number } | null = null;
header.addEventListener("pointerdown", (event) => {
  if (event.target === fold) return;
  const rect = host.getBoundingClientRect();
  drag = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
  header.setPointerCapture(event.pointerId);
});
header.addEventListener("pointermove", (event) => {
  if (!drag) return;
  host.style.right = "auto";
  host.style.left = `${Math.max(0, Math.min(innerWidth - host.offsetWidth, drag.left + event.clientX - drag.x))}px`;
  host.style.top = `${Math.max(0, Math.min(innerHeight - 40, drag.top + event.clientY - drag.y))}px`;
});
header.addEventListener("pointerup", () => {
  if (drag) {
    drag = null;
    void send({ type: "position", position: { left: host.style.left, top: host.style.top } }).catch(
      () => {},
    );
  }
});
// 表示位置は秘密値と分け、service worker経由で取得します。

void send({ type: "position" })
  .then((reply) => {
    const p = reply.data as { left?: string; top?: string } | undefined;
    if (p?.left && p.top) {
      host.style.right = "auto";
      host.style.left = p.left;
      host.style.top = p.top;
      clampPosition();
    }
  })
  .catch(() => {});

function clampPosition() {
  if (host.style.left)
    host.style.left = `${Math.max(0, Math.min(innerWidth - host.offsetWidth, Number.parseFloat(host.style.left)))}px`;
  host.style.top = `${Math.max(0, Math.min(innerHeight - 40, Number.parseFloat(host.style.top) || 0))}px`;
}
header.addEventListener("pointercancel", () => {
  drag = null;
});
