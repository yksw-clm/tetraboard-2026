import {
  getRoomContract,
  getRoomMembershipContract,
  roomSocketContract,
  type RoomSocketClientMessage,
} from "@tetraboard/protocol";
import { Api, ApiError } from "./api";
import {
  actionKey,
  actionMessage,
  deadline,
  sendAt,
  supported,
  turnFor,
  type Action,
  type Snapshot,
  type Turn,
} from "./game";
import { sleep, type Game, type Log } from "./config";
import type { Analysis } from "./ai";
import type { Seat } from "./store";

export class StopControl {
  mode: "running" | "drain" | "force" = "running";
  request() {
    this.mode = this.mode === "running" ? "drain" : "force";
  }
}
export class StopRequested extends Error {}
type Plan = { turn: Turn; at: number; abort: AbortController; candidate?: Action; error?: string };
export class RoomSession {
  private socket: WebSocket | null = null;
  private authenticated = false;
  private snapshot: Snapshot | null = null;
  private receivedAt = 0;
  private frameVersion = 0;
  private fatal = "";
  private plan: Plan | null = null;
  private analysisTail = Promise.resolve();
  private sentKey = "";
  private sentAt = 0;
  private interactionAt = 0;
  private commandFailed = false;
  constructor(
    private api: Api,
    private seat: Seat,
    private game: Game,
    private ai: Analysis,
    private stop: StopControl,
    private draining: () => boolean,
    private log: Log,
    private delay = sendAt,
    private pause = () => sleep(25),
  ) {}
  private invalidate() {
    this.plan?.abort.abort();
    this.plan = null;
  }
  private send(message: RoomSocketClientMessage): boolean {
    if (!this.authenticated || this.socket?.readyState !== WebSocket.OPEN) return false;
    roomSocketContract.clientMessage.parse(message);
    try {
      this.socket.send(JSON.stringify(message));
      return true;
    } catch {
      this.socket.close();
      return false;
    }
  }
  private accept(snapshot: Snapshot) {
    if (
      snapshot.room.instanceId !== this.seat.instanceId ||
      !supported(snapshot.room) ||
      snapshot.room.settings.game !== this.game
    ) {
      this.fatal = "参加先の世代・ゲーム・モードが変わりました";
      return;
    }
    if (this.snapshot && snapshot.serverNowMs < this.snapshot.serverNowMs) return;
    this.snapshot = snapshot;
    this.receivedAt = performance.now();
    this.frameVersion++;
  }
  private async connect(): Promise<boolean> {
    const frame = await this.api.request(
      `/api${getRoomContract.pathFor(this.seat.roomId)}`,
      getRoomContract.response,
    );
    if (frame.room.instanceId !== this.seat.instanceId) return false;
    await this.api.request(
      `/api${getRoomMembershipContract.pathFor(this.seat.roomId)}`,
      getRoomMembershipContract.response,
      { bearer: this.seat.token },
    );
    this.accept({ type: "room.snapshot", ...frame });
    if (this.fatal) throw Error(this.fatal);
    const url = new URL(`/api/rooms/${this.seat.roomId}/ws`, this.api.origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("instanceId", this.seat.instanceId);
    const socket = new WebSocket(url, { headers: { Origin: this.api.origin } });
    this.socket = socket;
    this.authenticated = false;
    this.sentKey = "";
    this.interactionAt = 0;
    socket.onopen = () => {
      if (this.socket === socket)
        socket.send(JSON.stringify({ type: "room.auth", token: this.seat.token }));
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket || typeof event.data !== "string") return;
      try {
        const parsed = roomSocketContract.message.parse(JSON.parse(event.data));
        if (parsed.type === "room.snapshot") this.accept(parsed);
        else if (parsed.type === "room.authenticated") {
          if (parsed.membership.playerId !== this.seat.playerId)
            this.fatal = "参加者が一致しません";
          else {
            this.authenticated = true;
            this.interactionAt = parsed.interactionAvailableAtMs ?? 0;
            this.log("connected", { room: this.seat.roomId });
          }
        } else if (parsed.type === "room.error") {
          this.commandFailed = true;
          this.log("room_error", { reason: parsed.error });
          if (["unauthorized", "not_found", "room_changed"].includes(parsed.error))
            this.fatal = "対局の参加資格を確認できません";
          this.invalidate();
        } else if (parsed.type === "room.tournament.return")
          this.fatal = "大会の参加資格が終了しました";
      } catch {
        this.fatal = "対局サーバーの応答形式に対応していません";
      }
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.authenticated = false;
      this.invalidate();
    };
    socket.onerror = () => {
      if (this.socket === socket) socket.close();
    };
    return true;
  }
  private tickTurn() {
    if (!this.authenticated || !this.snapshot) {
      this.invalidate();
      return;
    }
    const turn = turnFor(this.snapshot, this.seat.playerId, this.receivedAt);
    if (!turn || !turn.actions.length || this.sentKey === turn.key) {
      this.invalidate();
      return;
    }
    if (this.plan?.turn.key !== turn.key) {
      this.invalidate();
      const plan: Plan = { turn, at: this.delay(turn), abort: new AbortController() };
      this.plan = plan;
      this.analysisTail = this.analysisTail
        .catch(() => {})
        .then(async () => {
          if (plan.abort.signal.aborted) return;
          try {
            await this.ai.watch(turn, this.api, plan.abort.signal, (action) => {
              if (this.plan === plan && !plan.abort.signal.aborted) plan.candidate = action;
            });
          } catch {
            if (!plan.abort.signal.aborted) plan.error = "ai_unavailable_or_invalid";
          }
        });
    }
    const plan = this.plan!;
    plan.at = Math.min(plan.at, deadline(turn));
    if (performance.now() < plan.at) return;
    const candidate = plan.candidate;
    const action = candidate && turn.actions.find((a) => actionKey(a) === actionKey(candidate));
    if (!action)
      this.log("fallback", { reason: plan.error ?? "no_valid_candidate", room: this.seat.roomId });
    if (this.send(actionMessage(turn, action || turn.actions[0]))) {
      this.sentKey = turn.key;
      this.sentAt = performance.now();
      this.log("move", { room: this.seat.roomId, fallback: !action });
    }
    this.invalidate();
  }
  async play(assigned: boolean): Promise<"finished" | "stopped" | "lost"> {
    let wasPlaying = false;
    let readySent = false;
    let startSent = false;
    let openedAt = 0;
    let retryAt = 0;
    let checkedAt = -Infinity;
    let withdrawingAt: number | null = null;
    try {
      while (this.stop.mode !== "force") {
        if (this.fatal) throw Error(this.fatal);
        if (!this.socket || this.socket.readyState === WebSocket.CLOSED) {
          if (performance.now() < retryAt) {
            await sleep(50);
            continue;
          }
          try {
            if (!(await this.connect())) return "lost";
            readySent = false;
            startSent = false;
            withdrawingAt = null;
            openedAt = performance.now();
          } catch (error) {
            if (error instanceof ApiError && [404, 410].includes(error.status)) return "lost";
            if (!(error instanceof ApiError) || [401, 403].includes(error.status)) throw error;
            this.log("reconnecting", { room: this.seat.roomId });
            retryAt = performance.now() + 1000;
            await sleep(50);
            continue;
          }
        }
        if (!this.authenticated && performance.now() - openedAt > 5000) this.socket?.close();
        const frame = this.snapshot;
        if (!frame || !this.authenticated) {
          await sleep(50);
          continue;
        }
        const room = frame.room;
        if (!supported(room)) throw Error("対象外の対局です");
        if (this.commandFailed) {
          readySent = false;
          startSent = false;
          this.commandFailed = false;
        }
        if (room.status === "waiting") {
          this.invalidate();
          if (wasPlaying) {
            this.log("game_end", { room: this.seat.roomId });
            readySent = false;
            startSent = false;
            checkedAt = -Infinity;
          }
          if (assigned && room.lastRound) return "finished";
          wasPlaying = false;
          const self = room.players.find((p) => p.id === this.seat.playerId);
          if (!self) return "lost";
          if (self.kind === "human" && self.retired) return "lost";
          if (this.draining() && !assigned && !startSent) {
            if (withdrawingAt !== null) {
              if (this.frameVersion > withdrawingAt && !self.ready) return "stopped";
            } else if (self.ready || readySent) {
              const version = this.frameVersion;
              if (this.send({ type: "room.ready.set", ready: false })) withdrawingAt = version;
            } else return "stopped";
            await this.pause();
            continue;
          }
          const interactive =
            frame.serverNowMs + performance.now() - this.receivedAt >= this.interactionAt;
          if (
            !assigned &&
            !room.matchmaking &&
            !room.tournamentId &&
            interactive &&
            !this.draining()
          ) {
            if (performance.now() - checkedAt > 60000) {
              await this.api.checkAccess();
              checkedAt = performance.now();
              continue;
            }
            if (!self.ready && !readySent)
              readySent = this.send({ type: "room.ready.set", ready: true });
            if (
              frame.presence.hostPlayerId === self.id &&
              room.players.length === 4 &&
              room.players.every(
                (p) =>
                  p.ready && (p.kind === "cpu" || frame.presence.connectedPlayerIds.includes(p.id)),
              ) &&
              !startSent
            )
              startSent = this.send({ type: "room.game.start" });
          }
        } else {
          if (!wasPlaying) {
            this.log("game_start", { room: this.seat.roomId });
            readySent = false;
            startSent = false;
          }
          wasPlaying = true;
          this.tickTurn();
          if (this.sentKey && performance.now() - this.sentAt > 5000) {
            const current = turnFor(frame, this.seat.playerId, this.receivedAt);
            if (current?.key === this.sentKey) this.socket?.close();
          }
        }
        await this.pause();
      }
      return "stopped";
    } finally {
      this.invalidate();
      const socket = this.socket;
      this.socket = null;
      socket?.close();
      await Promise.race([this.analysisTail, sleep(1100)]);
    }
  }
}
