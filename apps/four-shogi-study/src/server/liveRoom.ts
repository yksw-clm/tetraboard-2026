import {
  getRoomContract,
  getFourShogiReplayContract,
  getPublicMatchContract,
  getPublicMatchReplayContract,
  isFourShogiMatch,
  roomSocketContract,
} from "@tetraboard/protocol";
import { isDeepStrictEqual } from "node:util";
import { restoreAnalysisPosition } from "@tetraboard/four-shogi/analysis";
import {
  liveReplayTarget,
  restoreLiveReplay,
  sameLiveRound,
  type LiveReplayTarget,
  type VerifiedLiveUpdate,
} from "../domain/liveReplay";
import { validatePublicReplay } from "../domain/publicReplay";
import { HttpError, readBoundedJson } from "./http";

export type { VerifiedLiveUpdate } from "../domain/liveReplay";
export type LiveRoomStatus = Readonly<{
  state: "connecting" | "syncing" | "live" | "reconnecting" | "finished" | "closed" | "error";
  message: string | null;
}>;
export type LiveRoomSession = Readonly<{
  start(): Promise<VerifiedLiveUpdate>;
  reconnect(): Promise<void>;
  close(): void;
}>;
type LiveSocket = Pick<WebSocket, "addEventListener" | "close">;
export type LiveRoomDependencies = Readonly<{
  fetch?: typeof fetch;
  createWebSocket?: (url: string) => LiveSocket;
  allowedOrigins?: readonly string[];
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  unschedule?: (timer: ReturnType<typeof setTimeout>) => void;
}>;
type LiveRoomCallbacks = Readonly<{
  onUpdate(update: VerifiedLiveUpdate): void | Promise<void>;
  onStatus(status: LiveRoomStatus): void;
}>;
const publicOrigins = ["https://tetraboard.net", "https://tetraboard-dev.chaossi-lab.workers.dev"];

export function liveRoomLocation(
  input: unknown,
  allowedOrigins: readonly string[] = publicOrigins,
) {
  if (typeof input !== "string") throw new HttpError(400, "観戦する部屋のURLを入力してください");
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new HttpError(400, "観戦する部屋のURLを入力してください");
  }
  const match = /^\/rooms\/(\d{5})\/?$/.exec(url.pathname);
  if (
    !allowedOrigins.includes(url.origin) ||
    url.username ||
    url.password ||
    !match ||
    [...url.searchParams.keys()].some((key) => key !== "instanceId") ||
    url.searchParams.getAll("instanceId").length > 1
  )
    throw new HttpError(400, "TetraBoardの観戦用ルームURLを指定してください");
  const query = roomSocketContract.query.parse(Object.fromEntries(url.searchParams));
  return {
    origin: url.origin,
    roomId: match[1],
    instanceId: query.instanceId,
    sourceUrl: `${url.origin}/rooms/${match[1]}${query.instanceId ? `?instanceId=${query.instanceId}` : ""}`,
  };
}

/** 観戦WSは更新通知として使い、完全履歴は固定prefixの読取りAPIから復元します。 */
export function createLiveRoomSession(
  input: unknown,
  callbacks: LiveRoomCallbacks,
  dependencies: LiveRoomDependencies = {},
): LiveRoomSession {
  const location = liveRoomLocation(input, dependencies.allowedOrigins);
  const fetcher = dependencies.fetch ?? fetch;
  const socketFactory = dependencies.createWebSocket ?? ((url: string) => new WebSocket(url));
  const schedule = dependencies.schedule ?? setTimeout;
  const unschedule = dependencies.unschedule ?? clearTimeout;
  let socket: LiveSocket | null = null;
  let controller = new AbortController();
  let generation = 0;
  let closed = false;
  let started = false;
  let retries = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let firstTimer: ReturnType<typeof setTimeout> | null = null;
  let firstSettled = false;
  let pending: { target: LiveReplayTarget; generation: number } | null = null;
  let pumping = false;
  let verified: VerifiedLiveUpdate | null = null;
  let lastTarget: LiveReplayTarget | null = null;
  let pinnedInstanceId = location.instanceId;
  let lastStatus: LiveRoomStatus | null = null;
  let resolveFirst: (update: VerifiedLiveUpdate) => void;
  let rejectFirst: (error: unknown) => void;
  const first = new Promise<VerifiedLiveUpdate>((resolve, reject) => {
    resolveFirst = resolve;
    rejectFirst = reject;
  });
  // startの呼出し前に切断されても未処理の拒否を発生させません。
  void first.catch(() => {});

  function completeFirst(update: VerifiedLiveUpdate) {
    if (firstSettled) return;
    firstSettled = true;
    if (firstTimer !== null) unschedule(firstTimer);
    firstTimer = null;
    resolveFirst(update);
  }
  function failFirst(error: unknown) {
    if (firstSettled) return;
    firstSettled = true;
    if (firstTimer !== null) unschedule(firstTimer);
    firstTimer = null;
    rejectFirst(error);
  }

  function status(state: LiveRoomStatus["state"], message: string | null = null) {
    if (lastStatus?.state === state && lastStatus.message === message) return;
    lastStatus = { state, message };
    callbacks.onStatus(lastStatus);
  }
  function current(epoch: number) {
    return !closed && generation === epoch;
  }
  function sourceUrl(instanceId: string) {
    return `${location.origin}/rooms/${location.roomId}?instanceId=${instanceId}`;
  }
  function stopConnection() {
    generation++;
    controller.abort();
    if (retryTimer !== null) unschedule(retryTimer);
    retryTimer = null;
    const old = socket;
    socket = null;
    old?.close();
  }
  async function read(path: string, signal: AbortSignal) {
    try {
      const response = await fetcher(`${location.origin}/api${path}`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
        redirect: "error",
        credentials: "omit",
        headers: { Accept: "application/json" },
      });
      if (!response.ok)
        throw new HttpError(
          response.status,
          `観戦データを取得できませんでした（HTTP ${response.status}）`,
        );
      return await readBoundedJson(response, 4 * 1024 * 1024);
    } catch (error) {
      if (signal.aborted || error instanceof HttpError) throw error;
      throw new HttpError(503, "観戦先との通信が途切れました。再接続します");
    }
  }
  async function archived(epoch: number, observed = verified ?? lastTarget): Promise<boolean> {
    if (!observed || (verified && sameLiveRound(verified, observed) && verified.finished))
      return false;
    const prior = verified && sameLiveRound(verified, observed) ? verified : null;
    const signal = controller.signal;
    const { match } = getPublicMatchContract.response.parse(
      await read(getPublicMatchContract.pathFor(observed.roundId), signal).catch(
        (error: unknown) => {
          if (error instanceof HttpError && error.status === 404)
            throw new HttpError(404, "終局棋譜の保存を待っています");
          throw error;
        },
      ),
    );
    if (!isFourShogiMatch(match) || match.id !== observed.roundId)
      throw new Error("終局棋譜の対局IDが一致しません");
    const pages = [];
    let cursor = 0;
    for (;;) {
      const page = getPublicMatchReplayContract.response.parse(
        await read(
          `${getPublicMatchReplayContract.pathFor(observed.roundId)}?cursor=${cursor}`,
          signal,
        ),
      );
      if (!current(epoch)) return false;
      pages.push(page);
      const next = cursor + page.events.length;
      if (page.nextCursor === null) break;
      if (next <= cursor || page.nextCursor !== next || pages.length >= 200)
        throw new Error("終局棋譜のページが連続していません");
      cursor = next;
    }
    const replay = await validatePublicReplay({ match }, pages);
    if (
      replay.events.length < observed.eventCount ||
      (prior &&
        (!isDeepStrictEqual(replay.initial, prior.replay.initial) ||
          prior.replay.events.some(
            (entry, index) => !isDeepStrictEqual(entry, replay.events[index]),
          )))
    )
      throw new Error("終局棋譜が観戦中の完全履歴と一致しません");
    const observedPosition = await restoreAnalysisPosition({
      ...replay,
      eventOffset: observed.eventCount,
    });
    const { repetitions: _repetitions, ...observedPublicState } = observedPosition.state;
    if (!isDeepStrictEqual(observedPublicState, observed.game))
      throw new Error("終局棋譜の途中局面が観戦中の局面と一致しません");
    const position = await restoreAnalysisPosition(replay);
    if (!current(epoch)) return false;
    const update: VerifiedLiveUpdate = {
      ...observed,
      sourceUrl: sourceUrl(observed.instanceId),
      eventCount: replay.events.length,
      game: match.game,
      finished: true,
      replay,
      position,
    };
    verified = update;
    await callbacks.onUpdate(update);
    if (!current(epoch)) return false;
    completeFirst(update);
    status("finished");
    return true;
  }
  function retry(message: string) {
    if (closed || retryTimer !== null) return;
    if (retries >= 5) {
      const error = new Error(`${message}。履歴を確定できませんでした。再接続してください`);
      status("error", error.message);
      failFirst(error);
      stopConnection();
      return;
    }
    status("reconnecting", message);
    const delay = [1000, 2000, 5000, 10000][Math.min(retries++, 3)];
    retryTimer = schedule(() => {
      retryTimer = null;
      void beginConnect();
    }, delay);
  }
  function failed(error: unknown) {
    if (closed) return;
    const message = error instanceof Error ? error.message : "観戦へ接続できませんでした";
    if (error instanceof HttpError && [404, 408, 429, 500, 502, 503, 504].includes(error.status)) {
      retry(message);
      return;
    }
    status(
      "error",
      error instanceof HttpError && error.status === 400
        ? "ライブ履歴APIが未対応か、取得条件が更新されています。API配信後に再接続してください"
        : message,
    );
    failFirst(error);
    stopConnection();
  }
  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (pending && !closed) {
        const { target, generation: epoch } = pending;
        pending = null;
        if (!current(epoch)) continue;
        if (
          verified &&
          sameLiveRound(verified, target) &&
          verified.eventCount >= target.eventCount
        ) {
          if (verified.eventCount === target.eventCount && verified.finished === target.finished) {
            if (!isDeepStrictEqual(verified.game, target.game)) {
              failed(new Error("同じ更新番号の観戦局面が変更されています"));
            } else if (lastStatus?.state !== (verified.finished ? "finished" : "live")) {
              await callbacks.onUpdate(verified);
              if (current(epoch)) status(verified.finished ? "finished" : "live");
            }
            continue;
          }
          if (verified.eventCount > target.eventCount) continue;
        }
        status("syncing");
        try {
          if (verified && !sameLiveRound(verified, target) && !verified.finished)
            await archived(epoch, verified);
          const signal = controller.signal;
          const update = await restoreLiveReplay(
            sourceUrl(target.instanceId),
            target,
            (cursor) => {
              const query = new URLSearchParams({
                instanceId: target.instanceId,
                cursor: String(cursor),
                throughEventCount: String(target.eventCount),
              });
              return read(
                `${getFourShogiReplayContract.pathFor(location.roomId, target.roundId)}?${query}`,
                signal,
              );
            },
            verified,
          );
          if (!current(epoch)) continue;
          verified = update;
          await callbacks.onUpdate(update);
          if (!current(epoch)) continue;
          if (retryTimer !== null) unschedule(retryTimer);
          retryTimer = null;
          retries = 0;
          status(update.finished ? "finished" : "live");
          completeFirst(update);
        } catch (error) {
          if (!current(epoch)) continue;
          if (error instanceof HttpError && error.status === 404) {
            try {
              if (await archived(epoch, target)) continue;
            } catch (archiveError) {
              if (!current(epoch)) continue;
              failed(archiveError);
              continue;
            }
          }
          failed(error);
        }
      }
    } finally {
      pumping = false;
    }
  }
  async function connect() {
    if (closed) throw new Error("観戦接続は終了しています");
    stopConnection();
    controller = new AbortController();
    const epoch = generation;
    status(started && verified ? "reconnecting" : "connecting");
    let room;
    try {
      room = getRoomContract.response.parse(
        await read(getRoomContract.pathFor(location.roomId), controller.signal),
      ).room;
    } catch (error) {
      if (!current(epoch)) return;
      if (error instanceof HttpError && error.status === 404 && (verified || lastTarget)) {
        if (await archived(epoch)) return;
      }
      throw error;
    }
    if (!current(epoch)) return;
    if (pinnedInstanceId && room.instanceId !== pinnedInstanceId)
      throw new HttpError(410, "部屋の世代が変わりました。新しい観戦URLを指定してください");
    pinnedInstanceId ??= room.instanceId;
    const nextTarget = liveReplayTarget(room);
    if (!nextTarget)
      throw new HttpError(409, "対局の開始前です。対局開始後に観戦URLを再接続してください");
    if (verified && nextTarget && !sameLiveRound(verified, nextTarget) && !verified.finished)
      await archived(epoch, verified);
    if (!current(epoch)) return;
    const query = new URLSearchParams({ instanceId: room.instanceId });
    const wsUrl = new URL(
      `/api${roomSocketContract.pathFor(location.roomId)}?${query}`,
      location.origin,
    );
    wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
    socket = socketFactory(wsUrl.href);
    socket.addEventListener("message", (event) => {
      if (!current(epoch)) return;
      try {
        const message = roomSocketContract.message.parse(JSON.parse(String(event.data)));
        if (message.type !== "room.snapshot") return;
        if (message.room.instanceId !== room.instanceId)
          throw new Error("観戦snapshotの部屋世代が一致しません");
        const target = liveReplayTarget(message.room);
        if (!target) {
          status("connecting", "対局の開始を待っています");
          return;
        }
        lastTarget = target;
        pending = { target, generation: epoch };
        void pump();
      } catch (error) {
        failed(error);
      }
    });
    socket.addEventListener("close", () => {
      if (current(epoch) && !verified?.finished)
        retry("観戦接続が切れました。完全履歴から再同期します");
    });
    socket.addEventListener("error", () => {
      if (current(epoch)) retry("観戦へ接続できませんでした。再接続します");
    });
  }
  async function beginConnect() {
    const operation = connect();
    const epoch = generation;
    try {
      await operation;
    } catch (error) {
      if (current(epoch)) failed(error);
    }
  }
  return {
    async start() {
      if (closed) throw new Error("観戦接続は終了しています");
      if (!started) {
        started = true;
        firstTimer = schedule(() => {
          const error = new Error(
            "観戦局面の完全履歴を30秒以内に取得できませんでした。再接続してください",
          );
          status("error", error.message);
          failFirst(error);
          stopConnection();
        }, 30000);
        void beginConnect();
      }
      return first;
    },
    async reconnect() {
      retries = 0;
      await beginConnect();
    },
    close() {
      if (closed) return;
      closed = true;
      pending = null;
      stopConnection();
      failFirst(new Error("観戦接続を終了しました"));
      status("closed");
    },
  };
}
