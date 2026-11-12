import {
  eligible,
  positionIdentity,
  revision,
  roomIdFromUrl,
  selfColor,
  validateProgress,
  continuousProfile,
  sides,
  handKinds,
  type ContinuousRequest,
  type ContinuousResponse,
  type Observation,
} from "./model";
import { ShogiReplayCache } from "./replay";
import { serviceStateSchema, type ServiceCommand, type ServiceState } from "./serviceProtocol";
export type Reply = { ok: boolean; error?: string; data?: unknown };
export type Transport = (message: unknown) => Promise<Reply>;
export class WidgetController {
  observation: Observation | null = null;
  enabled = false;
  busy = false;
  switching = false;
  error = "";
  result: ContinuousResponse | null = null;
  serviceState: ServiceState | "unknown" | "unavailable" = "unknown";
  serviceBusy = false;
  serviceError = "";
  private serviceVersion = 0;
  private checkingService = false;
  private cancelPoll: (() => void) | null = null;
  private abort: AbortController | null = null;
  private replay = new ShogiReplayCache();
  private version = 0;
  private epoch = 0;
  private identity = "";
  private lastAuto = "";
  private visible = true;
  private href: string;
  private needsObservation = false;
  constructor(
    private transport: Transport,
    private changed: () => void,
    href: string,
    private digest = revision,
    private loadReplay = (o: import("./model").ShogiObservation, signal: AbortSignal) =>
      this.replay.load(o, signal),
    private schedule = (callback: () => void): (() => void) => {
      const timer = setTimeout(callback, 1000);
      return () => clearTimeout(timer);
    },
  ) {
    this.href = href;
  }
  get canAnalyze() {
    return (
      this.enabled &&
      !this.switching &&
      !this.serviceBusy &&
      this.serviceState !== "stopped" &&
      this.visible &&
      !this.needsObservation &&
      eligible(this.observation) &&
      this.observation.roomId === roomIdFromUrl(this.href)
    );
  }
  async refreshService() {
    if (this.serviceBusy || this.checkingService) return;
    this.checkingService = true;
    const version = this.serviceVersion;
    try {
      const reply = await this.transport({ type: "service", command: "status" });
      if (version !== this.serviceVersion) return;
      if (!reply.ok) throw Error(reply.error ?? "AIの状態を確認できません");
      const state = serviceStateSchema.parse((reply.data as { state?: unknown })?.state);
      if (state === "stopped" && (this.busy || this.result)) this.invalidate();
      this.serviceState = state;
      this.serviceError = "";
    } catch (error) {
      if (version !== this.serviceVersion) return;
      if (this.serviceState === "running") {
        this.invalidate();
        this.lastAuto = this.identity;
      }
      this.serviceState = "unavailable";
      this.serviceError = error instanceof Error ? error.message : "AIの状態を確認できません";
    } finally {
      this.checkingService = false;
      this.changed();
    }
  }
  async controlService(command: Exclude<ServiceCommand, "status">) {
    if (this.serviceBusy) return;
    const version = ++this.serviceVersion;
    this.serviceBusy = true;
    this.serviceError = "";
    this.invalidate();
    this.changed();
    try {
      const reply = await this.transport({ type: "service", command });
      if (version !== this.serviceVersion) return;
      if (!reply.ok) throw Error(reply.error ?? "AIを操作できません");
      this.serviceState = serviceStateSchema.parse((reply.data as { state?: unknown })?.state);
      this.error = "";
      if (this.serviceState === "running") this.lastAuto = "";
    } catch (error) {
      this.serviceError = error instanceof Error ? error.message : "AIを操作できません";
    } finally {
      this.serviceBusy = false;
      this.changed();
      if (!this.serviceError) this.maybeAuto();
    }
  }
  serviceChanging() {
    this.serviceVersion++;
    this.serviceState = "unknown";
    this.invalidate();
    this.lastAuto = this.identity;
    this.changed();
  }
  private invalidate() {
    this.version++;
    this.cancelPoll?.();
    this.cancelPoll = null;
    this.abort?.abort();
    this.abort = null;
    this.result = null;
    this.busy = false;
    void this.transport({ type: "cancel" }).catch(() => {});
  }
  private fail(error: unknown) {
    this.error = error instanceof Error ? error.message : "解析に失敗しました";
    this.busy = false;
    void this.transport({ type: "cancel" }).catch(() => {});
    this.changed();
  }
  observe(next: Observation) {
    if (next.roomId !== roomIdFromUrl(this.href)) return;
    const previous = this.observation;
    if (
      previous &&
      previous.instanceId === next.instanceId &&
      previous.generation === next.generation &&
      next.serverNowMs < previous.serverNowMs
    )
      return;
    if (
      previous?.gameId === "four-shogi" &&
      next.gameId === "four-shogi" &&
      previous.instanceId === next.instanceId &&
      previous.generation === next.generation &&
      previous.roundId === next.roundId &&
      next.positionRevision < previous.positionRevision
    )
      return;
    if (
      previous &&
      (previous.instanceId !== next.instanceId ||
        previous.generation !== next.generation ||
        previous.status !== next.status ||
        (previous.game && next.game && next.game.moveNumber < previous.game.moveNumber))
    )
      this.epoch++;
    const nextIdentity = positionIdentity(next, new URL(this.href).origin, this.epoch);
    const meaningful =
      nextIdentity !== this.identity ||
      eligible(previous) !== eligible(next) ||
      this.needsObservation;
    if (meaningful) {
      this.invalidate();
      this.error = "";
    }
    this.observation = next;
    this.identity = nextIdentity;
    this.needsObservation = false;
    if (meaningful) this.changed();
    this.maybeAuto();
  }
  navigate(href: string) {
    if (new URL(href).pathname === new URL(this.href).pathname) return;
    this.href = href;
    this.epoch++;
    this.invalidate();
    this.observation = null;
    this.identity = "";
    this.lastAuto = "";
    this.error = "";
    this.needsObservation = true;
    this.changed();
  }
  setVisible(visible: boolean) {
    this.visible = visible;
    this.invalidate();
    this.lastAuto = "";
    this.needsObservation = true;
    this.changed();
  }
  revoke() {
    this.enabled = false;
    this.switching = false;
    this.invalidate();
    this.error = "別のタブでwidgetが有効になりました";
    this.changed();
  }
  async toggle() {
    if (this.switching || this.serviceBusy) return;
    if (this.enabled) {
      this.enabled = false;
      this.invalidate();
      this.changed();
      await this.transport({ type: "disable" });
      return;
    }
    this.switching = true;
    const version = ++this.version;
    this.changed();
    try {
      const enabled = await this.transport({ type: "enable" });
      if (version !== this.version) return;
      if (!enabled.ok) throw Error(enabled.error ?? "有効化できませんでした");
      this.enabled = true;
      this.error = "";
      this.lastAuto = "";
      const health = await this.transport({ type: "health" });
      if (version !== this.version) return;
      if (!health.ok) throw Error(health.error ?? "ローカルAIに接続できません");
    } catch (error) {
      if (version === this.version) {
        this.enabled = false;
        this.fail(error);
        await this.transport({ type: "disable" }).catch(() => {});
      }
    } finally {
      this.switching = false;
      this.changed();
      this.maybeAuto();
    }
  }
  stop() {
    this.lastAuto = this.identity;
    this.invalidate();
    this.error = "解析を停止しました";
    this.changed();
  }
  private maybeAuto() {
    if (
      this.canAnalyze &&
      eligible(this.observation) &&
      selfColor(this.observation) === this.observation.game.turn &&
      this.identity !== this.lastAuto &&
      !this.switching
    ) {
      this.lastAuto = this.identity;
      void this.analyze();
    }
  }
  async analyze() {
    if (!this.canAnalyze || !eligible(this.observation)) return;
    this.invalidate();
    const version = this.version,
      identity = this.identity,
      observation = this.observation;
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.busy = true;
    this.error = "";
    this.changed();
    const current = () => version === this.version && identity === this.identity && this.canAnalyze;
    try {
      const hash = await this.digest(identity);
      if (!current()) return;
      let input: ContinuousRequest["input"];
      if (observation.gameId === "four-reversi") {
        const g = observation.game;
        input = {
          game: "four-reversi",
          state: {
            board: g.board,
            turn: g.turn,
            moveNumber: g.moveNumber,
            lastMove: g.lastMove,
            eliminatedColors: g.eliminatedColors,
            consecutivePasses: g.consecutivePasses,
          },
        };
      } else {
        const g = observation.game;
        const events = await this.loadReplay(observation, signal);
        if (!current()) return;
        input = {
          game: "four-shogi",
          three_player_attack_prohibited: g.threePlayerAttackProhibited,
          events,
          state: {
            board: g.board.map((row) =>
              row.map((p) => (p ? { side: p.side, kind: p.kind, promoted: p.promoted } : null)),
            ),
            hands: sides.map((side) => handKinds.map((kind) => g.hands[side][kind])),
            turn: g.turn,
            moveNumber: g.moveNumber,
            eliminatedSides: g.eliminations.map((e) => e.side),
          },
        };
      }
      const request: ContinuousRequest = {
        api_version: 2,
        request_id: crypto.randomUUID(),
        position_revision: hash,
        profile_hash: continuousProfile(observation.gameId).hash,
        input,
      };
      const started = await this.transport({ type: "start", request });
      if (!current()) return;
      if (!started.ok) throw Error(started.error ?? "解析を開始できません");
      validateProgress(started.data, request, observation);
      let sequence = -1;
      const poll = async () => {
        if (!current()) return;
        try {
          const reply = await this.transport({ type: "poll", requestId: request.request_id });
          if (!current()) return;
          if (!reply.ok) throw Error(reply.error ?? "解析の進捗を取得できません");
          const result = validateProgress(reply.data, request, observation);
          if (result.status === "failed")
            throw Error("解析に失敗しました。棋譜と受信局面を確認して再解析してください");
          if (result.status === "stopped") throw Error("解析が終了しました。再解析してください");
          if (result.sequence > sequence) {
            sequence = result.sequence;
            this.result = result;
            this.changed();
          }
          this.cancelPoll = this.schedule(() => {
            void poll();
          });
        } catch (error) {
          if (current()) this.fail(error);
        }
      };
      // 開始応答後も同じ要求IDを取得し、探索はサービス内で保持します。
      await poll();
    } catch (error) {
      if (current()) this.fail(error);
    }
  }
}
