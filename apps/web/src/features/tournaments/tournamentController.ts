import { createContext, useContext, useSyncExternalStore } from "react";
import { createUuid } from "../../shared/createUuid";

type ControllerEnvironment = {
  isReload: () => boolean;
  locks: () => LockManager | undefined;
  channel?: () => BroadcastChannel | null;
};
const browserEnvironment: ControllerEnvironment = {
  isReload: () =>
    performance
      .getEntriesByType("navigation")
      .some((entry) => (entry as PerformanceNavigationTiming).type === "reload"),
  locks: () => navigator.locks,
};
type Ownership = { operationId: string; version: number; controllerId: string };

export class TournamentDocumentController {
  private identity = createUuid();
  private revision = 0;
  getRevision() {
    return this.revision;
  }
  private readonly ownership = new Map<string, Ownership>();
  private readonly listeners = new Set<() => void>();
  private readonly held = new Map<string, { promise: Promise<boolean>; release: () => void }>();
  private readonly environment: ControllerEnvironment;
  private readonly channel: BroadcastChannel | null;
  constructor(environment: ControllerEnvironment = browserEnvironment) {
    this.environment = environment;
    this.channel = environment.channel
      ? environment.channel()
      : typeof BroadcastChannel === "undefined"
        ? null
        : new BroadcastChannel("tetraboard:tournament-control");
    if (this.channel)
      this.channel.onmessage = (event: MessageEvent<unknown>) => {
        const value = event.data as {
          scope?: unknown;
          controllerId?: unknown;
          operationId?: unknown;
          version?: unknown;
        };
        if (
          typeof value?.scope !== "string" ||
          typeof value.controllerId !== "string" ||
          typeof value.version !== "number"
        )
          return;
        const owned = this.ownership.get(value.scope);
        // 古い通知や、すでに完了した別の待機の通知では現在の制御権を捨てません。
        if (
          owned &&
          value.controllerId !== this.identity &&
          value.operationId === owned.operationId &&
          value.version > owned.version
        ) {
          this.forget(value.scope);
          this.rotate();
        }
      };
  }
  remember(scope: string, operationId: string, version: number) {
    this.revision++;
    this.ownership.set(scope, { operationId, version, controllerId: this.identity });
  }
  version(scope: string, operationId?: string) {
    const owned = this.ownership.get(scope);
    return owned?.controllerId === this.identity && owned.operationId === operationId
      ? owned.version
      : null;
  }
  forget(scope: string) {
    this.revision++;
    this.ownership.delete(scope);
    this.release(scope);
  }
  announce(scope: string) {
    const owned = this.ownership.get(scope);
    if (owned) this.channel?.postMessage({ scope, ...owned });
  }
  readonly getIdentity = () => this.identity;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  rotate() {
    this.revision++;
    this.identity = createUuid();
    for (const listener of this.listeners) listener();
    return this.identity;
  }
  isReload() {
    return this.environment.isReload();
  }
  async acquire(scope: string, steal = false): Promise<boolean> {
    if (steal) this.release(scope);
    const existing = this.held.get(scope);
    if (existing) return existing.promise;
    const locks = this.environment.locks();
    if (!locks) return false;
    let resolveAcquired!: (acquired: boolean) => void;
    let release!: () => void;
    const promise = new Promise<boolean>((resolve) => {
      resolveAcquired = resolve;
    });
    const stopped = new Promise<void>((resolve) => {
      release = resolve;
    });
    const record = { promise, release };
    this.held.set(scope, record);
    const clear = () => {
      if (this.held.get(scope) === record) this.held.delete(scope);
    };
    void locks
      .request(
        `tetraboard:tournament-controller:${scope}`,
        steal ? { steal: true } : { ifAvailable: true },
        async (lock) => {
          resolveAcquired(Boolean(lock));
          if (lock) await stopped;
          else clear();
        },
      )
      .catch(() => {
        clear();
        resolveAcquired(false);
      });
    return promise;
  }
  release(scope: string) {
    this.held.get(scope)?.release();
    this.held.delete(scope);
  }
}
export const tournamentDocumentController = new TournamentDocumentController();
export const TournamentControllerContext = createContext(tournamentDocumentController);
export function useTournamentController() {
  const controller = useContext(TournamentControllerContext);
  const controllerId = useSyncExternalStore(
    controller.subscribe,
    controller.getIdentity,
    controller.getIdentity,
  );
  return { controller, controllerId };
}
