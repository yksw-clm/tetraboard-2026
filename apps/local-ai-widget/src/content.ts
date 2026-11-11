import { channel, observationSchema, roomIdFromUrl, eligible, colorNames } from "./model";
import { paintOverlay } from "./overlay";
import { WidgetController, type Reply } from "./controller";
import { localProfileIds, profileNames } from "./profiles";
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
function button(text: string, action: () => void, disabled = false) {
  const b = document.createElement("button");
  b.textContent = text;
  b.disabled = disabled;
  b.addEventListener("click", action);
  section.append(b);
}
function paragraph(text: string) {
  const p = document.createElement("p");
  p.textContent = text;
  section.append(p);
  return p;
}
async function send(message: unknown): Promise<Reply> {
  const response = await chrome.runtime.sendMessage(message);
  if (!response || typeof response.ok !== "boolean")
    throw Error("拡張への接続が切れました。ページを再読み込みしてください");
  return response;
}
function render() {
  const { enabled, observation, busy, result, error } = controller;
  host.hidden = !roomIdFromUrl(location.href);
  fold.textContent = collapsed ? "開く" : "折り畳む";
  section.hidden = collapsed;
  section.replaceChildren();
  const label = document.createElement("label"),
    select = document.createElement("select");
  label.textContent = "解析AI ";
  for (const id of localProfileIds) {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = profileNames[id];
    select.append(option);
  }
  select.value = controller.profileId;
  select.disabled = controller.switching;
  select.addEventListener("change", () => {
    const id = localProfileIds.find((id) => id === select.value);
    if (id) controller.selectProfile(id);
  });
  label.append(select);
  section.append(label, document.createElement("br"));
  button(
    enabled ? "無効にする" : "有効にする",
    () => {
      void controller.toggle();
    },
    controller.switching,
  );
  button(
    "解析・再解析",
    () => {
      void controller.analyze();
    },
    !controller.canAnalyze || busy,
  );
  button(
    "停止",
    () => {
      controller.stop();
    },
    !busy,
  );
  if (!enabled) {
    paragraph(error || "このタブでは無効です");
    return;
  }
  if (error) paragraph(error).setAttribute("role", "status");
  if (overlayError) paragraph(overlayError).setAttribute("role", "status");
  if (!eligible(observation)) {
    paragraph("参加中の四人リバーシ・シングルスの受信を待っています");
    return;
  }
  paragraph(
    `${profileNames[controller.profileId]} · ${colorNames[observation.game.turn]}の候補手 · ${observation.game.moveNumber}手目`,
  );
  if (busy) paragraph("解析中…").setAttribute("role", "status");
  if (result) {
    const ol = document.createElement("ol");
    for (const c of result.candidates) {
      const li = document.createElement("li");
      li.textContent = `${"ABCDEFGH"[c.position.x]}${c.position.y + 1} · ${c.visits}回`;
      ol.append(li);
    }
    section.append(ol);
    const top = result.candidates[0];
    if (top) {
      paragraph("推奨手後の探索内・単独1位率");
      paragraph(
        top.solo_wins
          .map(
            (n, i) =>
              `${colorNames[(["black", "white", "red", "blue"] as const)[i]]} ${((n / top.visits) * 100).toFixed(1)}%`,
          )
          .join(" / "),
      );
    } else paragraph("評価未取得：完走した探索がありません");
    const reason = {
      iteration_limit: "試行上限",
      node_limit: "着手適用上限",
      deadline: "時間上限・途中結果",
      terminal: "終局",
    }[result.diagnostics.mcts.stop_reason];
    paragraph(
      `${result.diagnostics.mcts.trials}試行 / ${result.diagnostics.nodes}着手適用 · ${reason}`,
    );
    const small = document.createElement("small");
    small.textContent =
      "探索内の参考値です。対人勝率ではありません。同率1位を含まず、合計100%にならない場合があります。";
    section.append(small);
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
