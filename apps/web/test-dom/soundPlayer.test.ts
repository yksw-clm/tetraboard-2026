import { expect, test, spyOn } from "bun:test";
import { SoundPlayer, type SoundEffect } from "../src/shared/soundPlayer";
import { roomSounds, useSoundEffects } from "../src/shared/soundEffects";
import { flush, renderHook } from "./harness";

function audio() {
  const effects: SoundEffect[] = ["join", "bot", "put", "start", "end"];
  const sources = Object.fromEntries(effects.map((sound) => [sound, sound])) as Record<
    SoundEffect,
    string
  >;
  const calls: string[] = [];
  const nodes: {
    buffer: AudioBuffer | null;
    at: number | null;
    stopped: boolean;
    onended: (() => void) | null;
    connect: () => void;
    disconnect: () => void;
    start: (at: number) => void;
    stop: () => void;
  }[] = [];
  const state = {
    available: true,
    visible: true,
    failFetch: false,
    failDecode: false,
    failResume: false,
    failCreate: false,
    failStart: false,
  };
  const context = {
    state: "suspended" as AudioContextState,
    currentTime: 10,
    destination: {},
    resume: () => {
      calls.push("resume");
      if (state.failResume) return Promise.reject(new Error("interrupted"));
      context.state = "running";
      return Promise.resolve();
    },
    decodeAudioData: (bytes: ArrayBuffer) => {
      calls.push("decode");
      if (state.failDecode) return Promise.reject(new Error("decoder failed"));
      return Promise.resolve({ duration: new Uint8Array(bytes)[0]! / 10 } as AudioBuffer);
    },
    createBufferSource: () => {
      const node = {
        buffer: null as AudioBuffer | null,
        at: null as number | null,
        stopped: false,
        onended: null as (() => void) | null,
        connect: () => {},
        disconnect: () => {},
        start: (at: number) => {
          if (state.failStart) throw new Error("start failed");
          node.at = at;
        },
        stop: () => {
          node.stopped = true;
        },
      };
      nodes.push(node);
      return node;
    },
  };
  const player = new SoundPlayer({
    sources,
    available: () => state.available,
    visible: () => state.visible,
    configureSession: () => {
      calls.push("ambient");
    },
    createContext: () => {
      calls.push("create");
      if (state.failCreate) throw new Error("unsupported");
      return context as unknown as AudioContext;
    },
    fetch: async (url) => {
      calls.push(`fetch:${url}`);
      if (state.failFetch) throw new Error("network");
      return new Response(new Uint8Array([effects.indexOf(url as SoundEffect) + 1]));
    },
  });
  return { player, context, state, calls, nodes };
}

test("音源を先読みし、操作内でambientを先に指定してcontextを一度だけ作りデコードを再利用", async () => {
  const a = audio();
  a.player.prepare();
  a.player.prepare();
  await flush();
  expect(a.calls.filter((c) => c.startsWith("fetch:"))).toHaveLength(5);
  expect(a.calls).not.toContain("create");
  a.player.play(["start"]);
  expect(a.nodes).toHaveLength(0);
  a.player.activate();
  expect(a.calls.slice(5, 8)).toEqual(["ambient", "create", "resume"]);
  await flush();
  a.player.activate();
  a.player.prepare();
  await flush();
  expect(a.calls.filter((c) => c === "create")).toHaveLength(1);
  expect(a.calls.filter((c) => c === "decode")).toHaveLength(5);
  a.player.play(["start"]);
  expect(a.nodes).toHaveLength(1);
});
test("準備前・非表示・中断中の音は捨て、復帰操作から新しい音だけを鳴らす", async () => {
  const a = audio();
  a.player.activate();
  a.player.play(["join"]);
  expect(a.nodes).toHaveLength(0);
  await flush();
  expect(a.nodes).toHaveLength(0);
  a.state.visible = false;
  a.player.play(["put", "end"]);
  a.state.visible = true;
  a.context.state = "suspended";
  a.player.play(["put"]);
  expect(a.nodes).toHaveLength(0);
  a.player.activate();
  a.player.play(["put"]);
  expect(a.nodes).toHaveLength(1);
});
test("最終手のputの終了後にendを予約し、本人の送信時putも待って、非表示時に予約を破棄", async () => {
  const a = audio();
  a.player.activate();
  await flush();
  a.player.play(["put", "end"]);
  expect(a.nodes[0]!.at).toBe(10);
  expect(a.nodes[1]!.at).toBeCloseTo(10.3);
  a.player.stop();
  expect(a.nodes.every((n) => n.stopped)).toBe(true);
  a.context.currentTime = 20;
  a.player.play(["put"]);
  a.context.currentTime = 20.1;
  a.player.play(["end"]);
  expect(a.nodes[3]!.at).toBeCloseTo(20.3);
  a.player.stop();
  a.player.play(["end"]);
  expect(a.nodes[4]!.at).toBe(20.1);
});
test("HTTP成功とWebSocketのjoinは到着順にかかわらず同じ人を一度だけ鳴らす", async () => {
  for (const first of ["http", "socket"] as const) {
    const a = audio();
    a.player.activate();
    await flush();
    const arrivals = first === "http" ? ["http", "socket"] : ["socket", "http"];
    for (const _arrival of arrivals) a.player.playJoin("room", "self");
    expect(a.nodes).toHaveLength(1);
    a.player.playJoin("room", "other");
    a.player.playJoin("next-room", "self");
    expect(a.nodes).toHaveLength(3);
  }
});
test("未対応API、context作成・resume・音源取得・デコード・再生失敗を呼出元へ伝播しない", async () => {
  for (const failure of [
    "available",
    "failCreate",
    "failResume",
    "failFetch",
    "failDecode",
    "failStart",
  ] as const) {
    const a = audio();
    a.state[failure] = failure !== "available";
    expect(() => a.player.prepare()).not.toThrow();
    expect(() => a.player.activate()).not.toThrow();
    await flush();
    expect(() => a.player.play(["put", "end"])).not.toThrow();
    expect(() => a.player.stop()).not.toThrow();
    expect(a.nodes.every((n) => n.at === null)).toBe(true);
    if (failure === "available") expect(a.calls).toEqual([]);
  }
});
test("操作のcaptureで音声を先に有効化し、合成イベントは無視、アンマウントで解除", () => {
  const activate = spyOn(roomSounds, "activate").mockImplementation(() => {});
  const stop = spyOn(roomSounds, "stop").mockImplementation(() => {});
  try {
    const h = renderHook(useSoundEffects, undefined);
    const event = new MouseEvent("click", { bubbles: true });
    document.dispatchEvent(event);
    expect(activate).not.toHaveBeenCalled();
    Object.defineProperty(event, "isTrusted", { value: true });
    let activatedBeforeBubble = false;
    const bubbling = () => {
      activatedBeforeBubble = activate.mock.calls.length === 1;
    };
    document.addEventListener("click", bubbling);
    document.dispatchEvent(event);
    document.removeEventListener("click", bubbling);
    expect(activatedBeforeBubble).toBe(true);
    const pointer = new PointerEvent("pointerup", { pointerType: "touch" });
    Object.defineProperty(pointer, "isTrusted", { value: true });
    document.dispatchEvent(pointer);
    const keyboard = new KeyboardEvent("keydown", { key: "Enter" });
    Object.defineProperty(keyboard, "isTrusted", { value: true });
    document.dispatchEvent(keyboard);
    expect(activate).toHaveBeenCalledTimes(3);
    h.unmount();
    document.dispatchEvent(event);
    expect(activate).toHaveBeenCalledTimes(3);
  } finally {
    activate.mockRestore();
    stop.mockRestore();
  }
});

test("参加成功から同じ部屋への画面・資格切替では入室音を切らず、離脱と別部屋では止める", async () => {
  const a = audio();
  a.player.activate();
  await flush();
  a.player.playJoin("room", "self");
  const release = a.player.retainRoom("room");
  release();
  const mounted = a.player.retainRoom("room");
  await flush();
  expect(a.nodes[0]!.stopped).toBe(false);
  mounted();
  await flush();
  expect(a.nodes[0]!.stopped).toBe(true);
  const old = a.player.retainRoom("room");
  a.player.play(["put", "end"]);
  a.player.playJoin("next", "self");
  const next = a.player.retainRoom("next");
  old();
  await flush();
  expect(a.nodes[1]!.stopped).toBe(true);
  expect(a.nodes[2]!.stopped).toBe(true);
  expect(a.nodes[3]!.stopped).toBe(false);
  next();
  await flush();
  expect(a.nodes[3]!.stopped).toBe(true);
});
