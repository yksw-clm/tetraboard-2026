import {
  eligible,
  positionIdentity,
  revision,
  roomIdFromUrl,
  selfColor,
  validateResult,
  type AnalysisRequest,
  type AnalysisResponse,
  type Observation,
} from "./model";
export type Reply = { ok: boolean; error?: string; data?: unknown };
export type Transport = (message: unknown) => Promise<Reply>;
export class WidgetController {
  observation: Observation | null = null;
  enabled = false;
  busy = false;
  switching = false;
  error = "";
  result: AnalysisResponse | null = null;
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
  ) {
    this.href = href;
  }
  get canAnalyze() {
    return (
      this.enabled &&
      this.visible &&
      !this.needsObservation &&
      eligible(this.observation) &&
      this.observation.roomId === roomIdFromUrl(this.href)
    );
  }
  private invalidate() {
    this.version++;
    this.result = null;
    this.busy = false;
    void this.transport({ type: "cancel" }).catch(() => {});
  }
  private fail(error: unknown) {
    this.error = error instanceof Error ? error.message : "解析に失敗しました";
    this.busy = false;
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
    if (this.switching) return;
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
      if (!health.ok) this.error = health.error ?? "ローカルAIに接続できません";
    } catch (error) {
      if (version === this.version) this.fail(error);
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
      game = this.observation.game;
    this.busy = true;
    this.error = "";
    this.changed();
    try {
      const hash = await this.digest(identity);
      if (version !== this.version || identity !== this.identity || !this.canAnalyze) return;
      const request: AnalysisRequest = {
        api_version: 1,
        ruleset_version: "four-reversi-singles-v2",
        state_version: 2,
        request_id: crypto.randomUUID(),
        position_revision: hash,
        profile_id: "lv5-v1",
        state: {
          board: game.board,
          turn: game.turn,
          moveNumber: game.moveNumber,
          lastMove: game.lastMove,
          eliminatedColors: game.eliminatedColors,
          consecutivePasses: game.consecutivePasses,
        },
      };
      const reply = await this.transport({ type: "analyze", request });
      if (version !== this.version || identity !== this.identity || !this.canAnalyze) return;
      if (!reply.ok) throw Error(reply.error ?? "解析に失敗しました");
      try {
        this.result = validateResult(reply.data, request);
      } catch {
        throw Error("解析応答が不正です。再解析してください");
      }
      this.busy = false;
      this.changed();
    } catch (error) {
      if (version === this.version) this.fail(error);
    }
  }
}
