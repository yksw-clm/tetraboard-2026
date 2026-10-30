import { getActionAvailability, getLegalActions, sides, type Side } from "@tetraboard/four-shogi";
import type { AnalysisPosition, FourShogiReplayEvent } from "@tetraboard/four-shogi/analysis";
import { evaluateStudyPosition } from "@tetraboard/four-shogi/study-search";
import { studySearchVersion, studyEvaluationVersion } from "@tetraboard/four-shogi/study-search";
import { aiVersions } from "@tetraboard/four-shogi/ai";
import { shogiMoveNotation } from "@tetraboard/shogi-ui/notation";
import type {
  StudyAnalysisCommand,
  StudyAnalysisView,
  StudyCommand,
  StudyConfig,
  StudyHistoryEntry,
  StudyServerEvent,
  StudySnapshot,
  StudyLiveView,
} from "../contracts";
import { StudyStore } from "../domain/store";
import {
  appendStudyEvent,
  cloneImportedStudy,
  createSetupStudy,
  createStudy,
  importReplayStudy,
  resolveStudyPositions,
  selectStudyNode,
  setStudyPlayEnabled,
  studyPositionInput,
  updateStudySettings,
  studyPath,
  setStudyComment,
  recordStudyAnalysis,
} from "../domain/study";
import { validatePublicReplay } from "../domain/publicReplay";
import { restoreRecordedCandidates } from "../domain/recordedAnalysis";
import { createStudySearchRuntime, type StudySearchRuntime } from "../search/runtime";
import type { StudyLifecycleEvent } from "../search/deadline";
import type { StudyDocument, StudyRecordedAnalysis } from "../shared/model";
import { HttpError, type StudyApplication } from "./http";
import { fetchPublicReplay } from "./publicImport";
import { createLiveRoomSession, type LiveRoomSession, type VerifiedLiveUpdate } from "./liveRoom";

const names: Record<Side, string> = { south: "南", west: "西", north: "北", east: "東" };

function eventLabel(
  before: AnalysisPosition,
  after: AnalysisPosition,
  event: FourShogiReplayEvent,
) {
  if (event.type === "drawProposal")
    return `${names[event.side]} ${event.proposed ? "引分提案" : "引分取消"}`;
  if (event.type === "eliminate")
    return `${names[event.side]} ${{ resigned: "投了", left: "退室", timeout: "時間切れ", disconnected: "通信切れ" }[event.reason]}`;
  const action = event.action;
  const piece =
    action.type === "dropPiece"
      ? { kind: action.pieceKind, promoted: false }
      : before.state.board[action.from.y][action.from.x];
  if (!piece) throw new Error("棋譜の移動元に駒がありません");
  const legalMoves = getLegalActions(before.state).flatMap((candidate) => {
    if (candidate.type !== "movePiece") return [];
    const source = before.state.board[candidate.from.y][candidate.from.x];
    return source ? [{ action: candidate, piece: source }] : [];
  });
  return `${after.state.moveNumber}: ${names[event.side]}${shogiMoveNotation({ action, piece, legalMoves, previousDestination: before.state.lastMove?.action.to ?? null, side: event.side, allowDragonStraight: true })}`;
}

function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new HttpError(400, "入力形式を確認してください");
  return input as Record<string, unknown>;
}

type ActiveSearch = {
  studyId: string;
  nodeId: string;
  generation: number;
  revision: number;
  stateHash: string;
  runtime: StudySearchRuntime;
  view: StudyAnalysisView | null;
  auto: boolean;
  focusSide: Side | null;
  conditions: { timeBudgetMs: number | null; threads: number; memoryMb: number };
  lastSavedElapsedMs: number;
};

export class LocalStudyApplication implements StudyApplication {
  private readonly documents = new Map<string, StudyDocument>();
  private readonly loads = new Map<string, Promise<StudyDocument>>();
  private readonly history = new Map<string, StudyHistoryEntry>();
  private readonly listeners = new Set<(event: StudyServerEvent) => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private active: ActiveSearch | null = null;
  private pool: { runtime: StudySearchRuntime; threads: number; memoryMb: number } | null = null;
  private generation = 0;
  private readonly analyses = new Map<string, StudyAnalysisView>();
  private readonly liveViews = new Map<string, StudyLiveView>();
  private readonly focusReconnect = new Set<string>();
  private watching: { session: LiveRoomSession; studyId: string | null } | null = null;

  constructor(
    private readonly store: StudyStore,
    private readonly config: StudyConfig,
    private readonly runtimeFactory = createStudySearchRuntime,
    private readonly liveFactory = createLiveRoomSession,
    private readonly observeLifecycle?: (event: StudyLifecycleEvent) => void,
  ) {}

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.queue.then(operation);
    this.queue = task.catch(() => {});
    return task;
  }
  private emit(event: StudyServerEvent) {
    for (const listener of this.listeners) listener(event);
  }
  subscribe(listener: (event: StudyServerEvent) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private async document(id: string) {
    const cached = this.documents.get(id);
    if (cached) return cached;
    const pending = this.loads.get(id);
    if (pending) return pending;
    const load = (async () => {
      const stored = await this.store.load(id);
      if (!stored) throw new HttpError(404, "検討が見つかりません");
      // 再起動後は明示的に再開するまで自動着手しません。
      const study = stored.playEnabled ? setStudyPlayEnabled(stored, false) : stored;
      if (study !== stored) await this.store.save(study, stored.revision);
      this.documents.set(id, study);
      return study;
    })();
    this.loads.set(id, load);
    try {
      return await load;
    } finally {
      this.loads.delete(id);
    }
  }
  private async save(study: StudyDocument, revision: number | null) {
    await this.store.save(study, revision);
    this.documents.set(study.id, study);
  }
  async list() {
    return (await this.store.list()).map(({ id, title, updatedAt, cpuSide, settings }) => ({
      id,
      title,
      updatedAt,
      cpuSide,
      cpuSides: sides.filter((side) => settings.seats[side].controller === "cpu"),
    }));
  }
  async get(id: string): Promise<StudySnapshot> {
    const requested = performance.now();
    const study = await this.document(id);
    const positions = await resolveStudyPositions(study);
    const position = positions.get(study.currentNodeId)!;
    const history = study.nodes.map((node) => {
      const key = `${study.id}:${node.id}`;
      let entry = this.history.get(key);
      if (!entry) {
        const state = positions.get(node.id)!;
        entry = {
          id: node.id,
          parentId: node.parentId,
          label:
            node.parentId && node.event
              ? eventLabel(positions.get(node.parentId)!, state, node.event)
              : "開始局面",
          moveNumber: state.state.moveNumber,
          evaluation: evaluateStudyPosition(state),
        };
        this.history.set(key, entry);
      }
      return entry;
    });
    const availability = getActionAvailability(position.state);
    let analysis = this.analyses.get(id) ?? null;
    const focusSide =
      this.active?.studyId === id &&
      this.active.nodeId === study.currentNodeId &&
      this.active.stateHash === position.stateHash
        ? this.active.focusSide
        : study.settings.focusSide;
    const matchesFocus = (view: StudyAnalysisView) => (view.focus?.side ?? null) === focusSide;
    const record = study.analysisRecords?.[study.currentNodeId];
    if (
      (!analysis ||
        analysis.nodeId !== study.currentNodeId ||
        analysis.stateHash !== position.stateHash ||
        !matchesFocus(analysis)) &&
      focusSide === null &&
      record?.stateHash === position.stateHash
    ) {
      const candidates = await restoreRecordedCandidates(record, position);
      analysis = {
        id: `saved-${study.currentNodeId}`,
        nodeId: study.currentNodeId,
        stateHash: position.stateHash,
        analysisStateHash: position.stateHash,
        focus: null,
        generation: 0,
        status: "completed",
        reason: "保存済みの解析結果",
        elapsedMs: record.elapsedMs,
        completedDepth: record.completedDepth,
        work: 0,
        nodes: 0,
        memoryBytes: 0,
        candidates,
        recommendedAction: candidates[0]?.action ?? null,
        analysisRecommendedAction: candidates[0]?.action ?? null,
        evaluation: record.evaluation,
        coverage: record.coverage,
        saved: {
          savedAt: record.savedAt,
          searchVersion: record.searchVersion,
          evaluationVersion: record.evaluationVersion,
          engineVersion: record.engineVersion,
          timeBudgetMs: record.timeBudgetMs,
          threads: record.threads,
          memoryMb: record.memoryMb,
        },
      };
    }
    const snapshot: StudySnapshot = {
      study,
      position,
      history,
      warnings: [...this.store.recoveries, ...this.store.errors].map((entry) => entry.message),
      legalActions: availability.legalActions,
      forbiddenActions: availability.threePlayerAttackForbiddenActions,
      staticEvaluation: evaluateStudyPosition(position),
      analysis:
        analysis?.nodeId === study.currentNodeId &&
        analysis.stateHash === position.stateHash &&
        matchesFocus(analysis)
          ? analysis
          : null,
      ...(this.liveViews.has(id) ? { live: this.liveViews.get(id) } : {}),
    };
    this.observeLifecycle?.({
      clock: "parent-monotonic",
      stage: "application-snapshot",
      id: analysis?.id ?? null,
      atMs: performance.now(),
      durationMs: performance.now() - requested,
    });
    return snapshot;
  }
  private async publish(id: string) {
    const snapshot = await this.get(id);
    this.emit({ type: "snapshot", snapshot });
    return snapshot;
  }
  private checkRevision(study: StudyDocument, revision: unknown) {
    if (!Number.isSafeInteger(revision) || revision !== study.revision)
      throw new HttpError(409, "局面が更新されています。最新の状態を読み直してください");
  }
  create(input: unknown) {
    return this.serial(async () => {
      const options = object(input);
      const cpuSide = options.cpuSide ?? "south";
      if (!sides.includes(cpuSide as Side)) throw new HttpError(400, "CPUの方向が不正です");
      if (
        options.threePlayerAttackProhibited !== undefined &&
        typeof options.threePlayerAttackProhibited !== "boolean"
      )
        throw new HttpError(400, "三人攻撃禁止の指定が不正です");
      const study = await createStudy({
        title: options.title as string | undefined,
        ...(options.cpuSide === undefined ? {} : { cpuSide: cpuSide as Side }),
        threePlayerAttackProhibited: options.threePlayerAttackProhibited as boolean | undefined,
        settings: {
          threads: this.config.defaultThreads,
          memoryMb: this.config.defaultMemoryMb,
          ...(options.settings ? object(options.settings) : {}),
        },
      });
      await this.holdOtherLive(study.id);
      await this.stopSearch();
      await this.save(study, null);
      await this.maybeFocus(study);
      return this.publish(study.id);
    });
  }
  command(id: string, input: StudyCommand) {
    if (input.type === "liveReconnect") return this.reconnectLive(id, input.expectedRevision);
    return this.serial(async () => {
      object(input);
      const study = await this.document(id);
      this.checkRevision(study, input.expectedRevision);
      const position = (await resolveStudyPositions(study)).get(study.currentNodeId)!;
      let next: StudyDocument;
      switch (input.type) {
        case "action":
          if (
            study.playEnabled &&
            study.settings.mode === "auto" &&
            position.state.status === "playing" &&
            study.settings.seats[position.state.turn].controller === "cpu"
          )
            throw new HttpError(409, "CPUの手番です。検討モードへ切り替えると手を選べます");
          next = await appendStudyEvent(study, {
            type: "action",
            side: position.state.turn,
            action: input.action,
          });
          break;
        case "event":
          next = await appendStudyEvent(study, input.event);
          break;
        case "select":
          next = selectStudyNode(study, input.nodeId);
          this.holdLive(id);
          break;
        case "comment":
          next = setStudyComment(study, input.nodeId, input.comment);
          await this.save(next, study.revision);
          return this.publish(id);
        case "variation": {
          const view = (await this.get(id)).analysis;
          if (
            !view ||
            view.id !== input.analysisId ||
            view.stateHash !== input.stateHash ||
            view.stateHash !== position.stateHash ||
            !Number.isSafeInteger(input.candidateIndex) ||
            !Number.isSafeInteger(input.plies)
          )
            throw new HttpError(409, "現在の解析結果の読み筋を選んでください");
          if (typeof input.lineSignature !== "string" || input.lineSignature.length > 100000)
            throw new HttpError(400, "読み筋の識別情報がありません");
          const prefix = view.focus?.prefix ?? [];
          if (
            view.focus &&
            (view.focus.status !== "ready" ||
              view.focus.sourceStateHash !== position.stateHash ||
              !view.analysisStateHash ||
              view.focus.analysisStateHash !== view.analysisStateHash)
          )
            throw new HttpError(409, "フォーカスする席の手番に到達した読み筋を選んでください");
          const candidate = view.candidates.find(
            (entry) =>
              JSON.stringify(
                [...prefix, ...entry.line.slice(0, input.plies)].map(({ side, action }) => ({
                  side,
                  action,
                })),
              ) === input.lineSignature,
          );
          if (input.plies < 1 || input.plies > 264)
            throw new HttpError(400, "読み筋の範囲が不正です");
          if (!candidate || input.plies > candidate.line.length)
            throw new HttpError(409, "読み筋が更新されました。表示された候補を選び直してください");
          next = setStudyPlayEnabled(study, false);
          for (const step of prefix)
            next = await appendStudyEvent(next, {
              type: "action",
              side: step.side,
              action: step.action,
            });
          if (view.focus) {
            const projected = (await resolveStudyPositions(next)).get(next.currentNodeId)!;
            if (
              projected.stateHash !== view.analysisStateHash ||
              projected.state.turn !== view.focus.side
            )
              throw new HttpError(409, "予測局面が更新されました。解析をやり直してください");
          }
          for (const step of candidate.line.slice(0, input.plies))
            next = await appendStudyEvent(next, {
              type: "action",
              side: step.side,
              action: step.action,
            });
          this.holdLive(id);
          break;
        }
        case "liveFollow": {
          const live = this.liveViews.get(id);
          if (!live || typeof input.enabled !== "boolean")
            throw new HttpError(400, "観戦中の対局を選んでください");
          this.liveViews.set(id, { ...live, follow: input.enabled });
          next = selectStudyNode(study, input.enabled ? live.latestNodeId : study.currentNodeId);
          break;
        }
        case "liveDisconnect": {
          const live = this.liveViews.get(id);
          if (!live) throw new HttpError(400, "観戦中の対局を選んでください");
          if (this.watching?.studyId === id) {
            this.watching.session.close();
            this.watching = null;
          }
          this.liveViews.set(id, {
            ...live,
            status: "closed",
            follow: false,
            message: "観戦を切断しました。取得済みの棋譜はMacに残ります。",
          });
          next = setStudyPlayEnabled(study, false);
          break;
        }
        case "settings":
          next = updateStudySettings(study, input.settings, { title: input.title });
          this.checkResources(next);
          break;
        case "pausePlay":
          next = setStudyPlayEnabled(study, false);
          break;
        case "resumePlay":
          this.holdLive(id);
          next = setStudyPlayEnabled(study, true);
          break;
        case "setup": {
          const edited = await createSetupStudy(input.setup, {
            title: input.title ?? `${study.title}（編集）`,
            cpuSide: study.cpuSide,
            settings: study.settings,
            sourceReference: { studyId: id, nodeId: study.currentNodeId },
          });
          await this.holdOtherLive(edited.id);
          await this.stopSearch();
          await this.save(edited, null);
          await this.maybeFocus(edited);
          return this.publish(edited.id);
        }
        default:
          throw new HttpError(400, "未対応の操作です");
      }
      if (["action", "event", "setup"].includes(input.type)) this.holdLive(id);
      await this.stopSearch();
      await this.save(next, study.revision);
      if (input.type === "liveFollow" && input.enabled) {
        if ((await resolveStudyPositions(next)).get(next.currentNodeId)!.state.status === "playing")
          await this.startSearch(next, false);
      } else {
        await this.maybeAuto(next);
        if (["action", "event", "select", "settings", "variation"].includes(input.type))
          await this.maybeFocus(next);
      }
      return this.publish(id);
    });
  }
  private checkResources(study: StudyDocument) {
    if (study.settings.threads > Math.max(1, this.config.logicalCpus - 2))
      throw new HttpError(
        400,
        `探索プロセス数は1〜${Math.max(1, this.config.logicalCpus - 2)}です`,
      );
    if (study.settings.memoryMb > Math.floor(this.config.totalMemoryMb * 0.75))
      throw new HttpError(400, "探索メモリは搭載メモリの75%以下にしてください");
  }
  private async maybeAuto(study: StudyDocument) {
    const position = (await resolveStudyPositions(study)).get(study.currentNodeId)!;
    if (
      study.playEnabled &&
      study.settings.mode === "auto" &&
      position.state.status === "playing" &&
      study.settings.seats[position.state.turn].controller === "cpu"
    )
      await this.startSearch(study, true);
  }
  private async maybeFocus(study: StudyDocument) {
    if (
      study.settings.focusSide !== null &&
      !study.playEnabled &&
      (await resolveStudyPositions(study)).get(study.currentNodeId)!.state.status === "playing"
    )
      await this.startSearch(study, false);
  }
  private holdLive(id: string) {
    this.focusReconnect.delete(id);
    const live = this.liveViews.get(id);
    if (live) this.liveViews.set(id, { ...live, follow: false });
  }
  private async holdOtherLive(studyId: string) {
    for (const [id, live] of this.liveViews)
      if (id !== studyId && live.follow) {
        this.focusReconnect.delete(id);
        this.liveViews.set(id, { ...live, follow: false });
        await this.publish(id);
      }
  }
  private async saveAnalysis(
    active: ActiveSearch,
    view: StudyAnalysisView,
    current: StudyDocument,
  ): Promise<StudyDocument> {
    // 予測付き解析は通常局面の保存形式へ混ぜず、対象席を変えた結果の再利用を防ぎます。
    if (active.focusSide !== null) return current;
    if (view.elapsedMs <= active.lastSavedElapsedMs) return current;
    if (
      !view.evaluation ||
      view.completedDepth < 1 ||
      !view.candidates.some((candidate) => candidate.evaluation && candidate.line.length)
    )
      return current;
    const position = (await resolveStudyPositions(current)).get(active.nodeId);
    if (!position || position.stateHash !== active.stateHash) return current;
    const record: StudyRecordedAnalysis = {
      stateHash: view.stateHash,
      savedAt: new Date().toISOString(),
      searchVersion: view.searchVersion ?? studySearchVersion,
      ...(view.coverage ? { coverage: view.coverage } : {}),
      evaluationVersion: studyEvaluationVersion,
      engineVersion: aiVersions.engineVersion,
      ...active.conditions,
      elapsedMs: view.elapsedMs,
      completedDepth: view.completedDepth,
      evaluation: view.evaluation,
      candidates: view.candidates
        .filter((candidate) => candidate.evaluation && candidate.line.length)
        .slice(0, 5)
        .map((candidate) => ({
          evaluation: candidate.evaluation!,
          events: candidate.line.map((step) => ({
            type: "action" as const,
            side: step.side,
            action: step.action,
          })),
        })),
    };
    const next = recordStudyAnalysis(current, active.nodeId, record);
    await this.save(next, current.revision);
    active.lastSavedElapsedMs = view.elapsedMs;
    return next;
  }
  private async stopSearch() {
    const active = this.active;
    this.active = null;
    if (!active) return;
    if (active.view && ["running", "paused"].includes(active.view.status)) {
      const view: StudyAnalysisView = {
        ...active.view,
        status: "cancelled",
        reason: "局面または操作が変更されました",
      };
      this.analyses.set(active.studyId, view);
      this.emit({ type: "analysis", studyId: active.studyId, analysis: view });
    }
    if (active.view) await active.runtime.cancel(active.view.id);
    const view = active.view;
    if (view && view.completedDepth > 0)
      void this.serial(async () => {
        const current = await this.document(active.studyId);
        await this.saveAnalysis(active, view, current);
        await this.publish(active.studyId);
      }).catch((error: unknown) =>
        this.emit({
          type: "error",
          studyId: active.studyId,
          message: error instanceof Error ? error.message : "解析結果を保存できませんでした",
        }),
      );
  }
  private async startSearch(study: StudyDocument, auto: boolean) {
    await this.holdOtherLive(study.id);
    this.checkResources(study);
    await this.stopSearch();
    const position = (await resolveStudyPositions(study)).get(study.currentNodeId)!;
    if (position.state.status === "finished")
      throw new HttpError(400, "終局した局面です。途中の局面を選んでください");
    if (
      this.pool &&
      (this.pool.threads !== study.settings.threads ||
        this.pool.memoryMb !== study.settings.memoryMb)
    ) {
      await this.pool.runtime.close();
      this.pool = null;
    }
    this.pool ??= {
      runtime: this.runtimeFactory({
        threads: study.settings.threads,
        memoryMb: study.settings.memoryMb,
      }),
      threads: study.settings.threads,
      memoryMb: study.settings.memoryMb,
    };
    const runtime = this.pool.runtime;
    this.focusReconnect.delete(study.id);
    const active: ActiveSearch = {
      studyId: study.id,
      nodeId: study.currentNodeId,
      stateHash: position.stateHash,
      generation: ++this.generation,
      revision: study.revision,
      runtime,
      view: null,
      auto,
      focusSide: auto ? null : study.settings.focusSide,
      conditions: {
        timeBudgetMs: auto
          ? study.settings.seats[position.state.turn].thinkTimeMs
          : study.settings.analysisTimeMs,
        threads: study.settings.threads,
        memoryMb: study.settings.memoryMb,
      },
      lastSavedElapsedMs: -1,
    };
    this.active = active;
    await runtime.start(
      studyPositionInput(study),
      {
        strategy: study.settings.searchStrategy ?? "adaptive",
        focusSide: active.focusSide,
        timeBudgetMs: auto
          ? study.settings.seats[position.state.turn].thinkTimeMs
          : study.settings.analysisTimeMs,
      },
      (progress) => {
        if (this.active !== active || progress.stateHash !== active.stateHash) return;
        const view: StudyAnalysisView = {
          completion: progress.completion,
          lethalGuard: progress.lethalGuard,
          coverage: progress.coverage,
          broadCandidates: progress.broadCandidates,
          searchVersion: progress.diagnostics.searchVersion,
          id: progress.id,
          nodeId: active.nodeId,
          stateHash: active.stateHash,
          analysisStateHash: progress.analysisStateHash,
          analysisRecommendedAction: progress.analysisRecommendedAction,
          focus: progress.focus,
          generation: active.generation,
          status: progress.status,
          reason: progress.reason,
          elapsedMs: progress.elapsedMs,
          completedDepth: progress.completedDepth,
          work: progress.work,
          nodes: progress.nodes,
          memoryBytes: progress.memoryBytes,
          performance: progress.performance,
          candidates: progress.candidates,
          recommendedAction: progress.recommendedAction,
          evaluation: progress.evaluation,
        };
        active.view = view;
        this.analyses.set(study.id, view);
        this.emit({ type: "analysis", studyId: study.id, analysis: view });
        if (["completed", "error"].includes(view.status)) {
          void this.serial(async () => {
            let current = await this.document(study.id);
            if (this.active !== active) return;
            const applyAutomatically =
              auto &&
              active.auto &&
              current.currentNodeId === active.nodeId &&
              current.playEnabled &&
              current.settings.mode === "auto";
            current = await this.saveAnalysis(active, view, current);
            active.revision = current.revision;
            if (
              !applyAutomatically ||
              view.status !== "completed" ||
              !view.recommendedAction ||
              view.reason === "memory_limit"
            ) {
              if (applyAutomatically) {
                const paused = setStudyPlayEnabled(current, false);
                await this.save(paused, current.revision);
              }
              await this.publish(current.id);
              return;
            }
            const now = (await resolveStudyPositions(current)).get(current.currentNodeId)!;
            if (now.stateHash !== active.stateHash) return;
            const next = await appendStudyEvent(current, {
              type: "action",
              side: now.state.turn,
              action: view.recommendedAction,
            });
            await this.stopSearch();
            await this.save(next, current.revision);
            await this.maybeAuto(next);
            await this.publish(next.id);
          }).catch((error: unknown) =>
            this.emit({
              type: "error",
              studyId: study.id,
              message: error instanceof Error ? error.message : "CPUの着手を確定できませんでした",
            }),
          );
        }
      },
    );
  }
  analyze(id: string, input: StudyAnalysisCommand) {
    return this.serial(async () => {
      object(input);
      const study = await this.document(id);
      this.checkRevision(study, input.expectedRevision);
      if (input.command === "start") {
        const paused = study.playEnabled ? setStudyPlayEnabled(study, false) : study;
        if (paused !== study) await this.save(paused, study.revision);
        await this.startSearch(paused, false);
      } else {
        const active = this.active;
        const view = (await this.get(id)).analysis;
        if (!view) throw new HttpError(409, "この局面の解析を開始してください");
        if (input.command === "pause") {
          if (!active || active.studyId !== id)
            throw new HttpError(409, "実行中の探索がありません");
          active.auto = false;
          await active.runtime.pause(view.id);
          const saved = await this.saveAnalysis(active, active.view ?? view, study);
          active.revision = saved.revision;
          if (saved.playEnabled) await this.save(setStudyPlayEnabled(saved, false), saved.revision);
        } else if (input.command === "resume") {
          if (!active || active.studyId !== id) throw new HttpError(409, "探索を開始してください");
          active.auto = false;
          active.generation = ++this.generation;
          await active.runtime.resume(view.id);
        } else if (input.command === "adopt") {
          const action = input.action ?? view.recommendedAction;
          if (
            input.analysisId !== view.id ||
            input.stateHash !== view.stateHash ||
            view.completedDepth < 1 ||
            !action ||
            !view.candidates.some(
              (candidate) => JSON.stringify(candidate.action) === JSON.stringify(action),
            )
          )
            throw new HttpError(409, "比較が完成した現在局面の候補を選んでください");
          const position = (await resolveStudyPositions(study)).get(study.currentNodeId)!;
          if (position.stateHash !== view.stateHash)
            throw new HttpError(409, "解析中に局面が変わりました");
          if (
            view.focus &&
            (view.focus.status !== "ready" ||
              position.state.turn !== view.focus.side ||
              view.focus.prefix.length !== 0 ||
              view.focus.sourceStateHash !== position.stateHash ||
              view.analysisStateHash !== position.stateHash ||
              view.focus.analysisStateHash !== position.stateHash)
          )
            throw new HttpError(
              409,
              "他の席の予測を含む推奨手は読み筋の分岐として追加してください",
            );
          const next = await appendStudyEvent(study, {
            type: "action",
            side: position.state.turn,
            action,
          });
          this.holdLive(id);
          await this.stopSearch();
          await this.save(next, study.revision);
          await this.maybeAuto(next);
          await this.maybeFocus(next);
        } else throw new HttpError(400, "未対応の解析操作です");
      }
      return this.publish(id);
    });
  }
  import(input: unknown) {
    return this.serial(async () => {
      const value = object(input);
      let study: StudyDocument;
      if (typeof value.url === "string") {
        const { detail, pages, sourceUrl } = await fetchPublicReplay(value.url);
        const replay = await validatePublicReplay(detail, pages);
        study = await importReplayStudy(replay, {
          sourceUrl,
          title: "公開棋譜の検討",
          settings: {
            mode: "analysis",
            threads: this.config.defaultThreads,
            memoryMb: this.config.defaultMemoryMb,
          },
        });
      } else if (value.data !== undefined) {
        const data = object(value.data);
        study =
          "nodes" in data
            ? await cloneImportedStudy(data)
            : await importReplayStudy(data, {
                settings: {
                  threads: this.config.defaultThreads,
                  memoryMb: this.config.defaultMemoryMb,
                },
              });
      } else throw new HttpError(400, "棋譜URLまたは保存ファイルを指定してください");
      this.checkResources(study);
      await this.holdOtherLive(study.id);
      await this.stopSearch();
      await this.save(study, null);
      await this.maybeFocus(study);
      return this.publish(study.id);
    });
  }
  async export(id: string) {
    return this.document(id);
  }
  watch(input: unknown): Promise<StudySnapshot> {
    return this.startWatching(input);
  }
  private async startWatching(
    input: unknown,
    studyId: string | null = null,
  ): Promise<StudySnapshot> {
    const value = object(input);
    const binding: { session: LiveRoomSession; studyId: string | null } = {
      session: null!,
      studyId,
    };
    const session = this.liveFactory(value.url, {
      onUpdate: (update) => this.serial(() => this.acceptLive(binding, update)),
      onStatus: (status) => {
        if (this.watching !== binding || !binding.studyId) return;
        const id = binding.studyId;
        void this.serial(async () => {
          if (this.watching !== binding) return;
          const live = this.liveViews.get(id);
          if (!live) return;
          this.liveViews.set(id, { ...live, status: status.state, message: status.message });
          if (
            ["error", "closed", "reconnecting"].includes(status.state) &&
            this.active?.studyId === id
          ) {
            if (
              live.follow &&
              this.active.focusSide !== null &&
              this.active.view?.status !== "paused"
            )
              this.focusReconnect.add(id);
            await this.stopSearch();
          }
          await this.publish(id);
        }).catch((error: unknown) =>
          this.emit({ type: "error", studyId: id, message: String(error) }),
        );
      },
    });
    binding.session = session;
    this.watching?.session.close();
    this.watching = binding;
    try {
      await session.start();
      if (!binding.studyId) throw new Error("観戦の初期局面を復元できませんでした");
      return this.get(binding.studyId);
    } catch (error) {
      session.close();
      if (this.watching === binding) this.watching = null;
      throw error;
    }
  }
  private async acceptLive(
    binding: { session: LiveRoomSession; studyId: string | null },
    update: VerifiedLiveUpdate,
  ) {
    if (this.watching !== binding) return;
    const priorId = binding.studyId;
    const previous = priorId ? this.liveViews.get(priorId) : null;
    if (
      !previous ||
      previous.instanceId !== update.instanceId ||
      previous.roundId !== update.roundId
    ) {
      const priorStudy = priorId ? await this.document(priorId) : null;
      const follow = !priorId || !!(previous?.follow && priorStudy?.settings.focusSide);
      const study = await importReplayStudy(update.replay, {
        sourceUrl: update.sourceUrl,
        title: "ライブ対局の検討",
        settings: {
          ...priorStudy?.settings,
          mode: "analysis",
          threads: this.config.defaultThreads,
          memoryMb: this.config.defaultMemoryMb,
        },
      });
      if (!priorId || (previous?.follow && this.active?.studyId === priorId))
        await this.stopSearch();
      await this.save(study, null);
      binding.studyId = study.id;
      this.liveViews.set(study.id, {
        sourceUrl: update.sourceUrl,
        instanceId: update.instanceId,
        roundId: update.roundId,
        eventCount: update.eventCount,
        latestNodeId: study.currentNodeId,
        follow,
        status: update.finished ? "finished" : "live",
        message: null,
      });
      if (priorId && previous) {
        this.liveViews.set(priorId, {
          ...previous,
          follow: false,
          nextStudyId: study.id,
          status: "finished",
          message: "新しい対局が始まりました。新しい検討を開けます。",
        });
        await this.publish(priorId);
      }
      await this.publish(study.id);
      if (follow && update.position.state.status === "playing")
        await this.startSearch(study, false);
      return;
    }
    if (!priorId || update.eventCount < previous.eventCount) return;
    const original = await this.document(priorId);
    const events = studyPath(original, previous.latestNodeId).flatMap((node) =>
      node.event ? [node.event] : [],
    );
    if (
      events.length !== previous.eventCount ||
      events.some(
        (event, index) =>
          JSON.stringify(event) !== JSON.stringify(update.replay.events[index]?.event),
      )
    )
      throw new Error("観戦中の棋譜と受信履歴が一致しません");
    let next = original;
    if (update.eventCount > previous.eventCount) {
      next = selectStudyNode(next, previous.latestNodeId);
      for (const { event } of update.replay.events.slice(previous.eventCount))
        next = await appendStudyEvent(next, event);
      const latestNodeId = next.currentNodeId;
      if (!previous.follow) next = selectStudyNode(next, original.currentNodeId);
      if (previous.follow) await this.stopSearch();
      await this.save(next, original.revision);
      this.liveViews.set(priorId, {
        ...previous,
        eventCount: update.eventCount,
        latestNodeId,
        status: update.finished ? "finished" : "live",
        message: null,
      });
    } else
      this.liveViews.set(priorId, {
        ...previous,
        status: update.finished ? "finished" : "live",
        message: null,
      });
    await this.publish(priorId);
    if (
      previous.follow &&
      (update.eventCount > previous.eventCount ||
        (this.focusReconnect.has(priorId) && next.settings.focusSide !== null && !this.active)) &&
      update.position.state.status === "playing"
    )
      await this.startSearch(next, false);
  }
  private async reconnectLive(id: string, revision: number) {
    await this.serial(async () => this.checkRevision(await this.document(id), revision));
    if (this.watching?.studyId !== id) {
      const live = this.liveViews.get(id);
      if (!live) throw new HttpError(400, "観戦URLから接続してください");
      return this.startWatching({ url: live.sourceUrl }, id);
    }
    await this.watching.session.reconnect();
    return this.get(id);
  }
  async close() {
    this.watching?.session.close();
    this.watching = null;
    await this.queue;
    await this.stopSearch();
    await this.queue;
    await this.pool?.runtime.close();
    this.pool = null;
  }
}
