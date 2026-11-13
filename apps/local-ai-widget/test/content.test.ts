import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { settle } from "./fixtures";

const script = await Bun.file(new URL("../dist/content.js", import.meta.url)).text();
test("無効なwidgetでもAIを起動・停止でき、定期更新でボタンとフォーカスを保つ", async () => {
  const w = new Window({ url: "https://tetraboard.net/rooms/12345" });
  let shadow: ReturnType<typeof w.HTMLElement.prototype.attachShadow> | null = null;
  const attachShadow = w.HTMLElement.prototype.attachShadow;
  w.HTMLElement.prototype.attachShadow = function (init) {
    shadow = attachShadow.call(this, init);
    return shadow;
  };
  const callbacks: (() => void)[] = [];
  w.setInterval = ((callback: () => void) => {
    callbacks.push(callback);
    return 1;
  }) as unknown as typeof w.setInterval;
  let state = "stopped";
  const commands: string[] = [];
  Object.assign(w, {
    chrome: {
      runtime: {
        onMessage: { addListener() {} },
        sendMessage: async (message: { type: string; command?: string }) => {
          if (message.type !== "service") return { ok: true };
          commands.push(message.command!);
          if (message.command === "start" || message.command === "restart") state = "running";
          if (message.command === "stop") state = "stopped";
          return { ok: true, data: { state } };
        },
      },
    },
  });
  try {
    w.eval(script);
    await settle();
    const root = shadow! as unknown as ShadowRoot;
    const button = (label: string) =>
      [...root.querySelectorAll("button")].find((b) => b.textContent === label)!;
    const start = button("AI起動"),
      stop = button("AI停止");
    expect(start.disabled).toBe(false);
    expect(stop.disabled).toBe(true);
    start.click();
    await settle();
    expect(stop.disabled).toBe(false);
    expect(root.textContent).toContain("ローカルAI：起動中");
    expect(root.textContent).toContain("このタブでは無効です");
    stop.focus();
    callbacks[0]();
    await settle();
    expect(button("AI停止")).toBe(stop);
    expect(root.activeElement).toBe(stop);
    button("再起動").click();
    await settle();
    stop.click();
    await settle();
    expect(root.textContent).toContain("ローカルAI：停止中");
    expect(commands).toEqual(["status", "start", "status", "restart", "stop"]);
  } finally {
    await w.happyDOM.close();
  }
});
