import {
  getPlayerProfileContract,
  type PlayerProfile,
  type PlayerProfileTarget,
} from "@tetraboard/protocol";
import type { GameId } from "@tetraboard/protocol/games";
export type ProfileState = {
  loading: boolean;
  profile: PlayerProfile | null;
  error: string | null;
  loadedAt: number;
};
export const emptyProfileState: ProfileState = {
  loading: false,
  profile: null,
  error: null,
  loadedAt: 0,
};
export const profileKey = (target: PlayerProfileTarget, game: GameId) =>
  JSON.stringify([game, target]);
export class PlayerProfileStore {
  private states = new Map<string, ProfileState>();
  private targets = new Map<string, { target: PlayerProfileTarget; game: GameId }>();
  private aliases = new Map<string, string>();
  private pending = new Map<string, AbortController>();
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  get = (key: string) => this.states.get(this.aliases.get(key) ?? key) ?? emptyProfileState;
  private emit() {
    for (const listener of this.listeners) listener();
  }
  async load(target: PlayerProfileTarget, game: GameId, force = false) {
    const original = profileKey(target, game);
    this.targets.set(original, { target, game });
    const key = this.aliases.get(original) ?? original;
    if (this.pending.has(key)) return;
    const state = this.get(key);
    if (!force && state.profile && Date.now() - state.loadedAt < 60_000) return;
    const controller = new AbortController();
    this.pending.set(key, controller);
    this.states.set(key, { ...state, loading: true, error: null });
    this.emit();
    try {
      const query = new URLSearchParams({ ...target, game, includeBadges: "1" });
      const fetchProfile = () =>
        fetch(`/api${getPlayerProfileContract.path}?${query}`, {
          cache: "no-store",
          signal: controller.signal,
        });
      let response = await fetchProfile();
      if (response.status === 400 && !controller.signal.aborted) {
        query.delete("includeBadges");
        response = await fetchProfile();
      }
      if (!response.ok)
        throw new Error(
          response.status === 404 || response.status === 410
            ? "プロフィールを表示できません。"
            : "プレイヤー情報を取得できませんでした。",
        );
      const profile = getPlayerProfileContract.response.parse(await response.json());
      if (profile.kind === "account" && profile.game !== game)
        throw new Error("プレイヤー情報を取得できませんでした。");
      if (controller.signal.aborted || this.pending.get(key) !== controller) return;
      const canonical =
        profile.kind === "account"
          ? profileKey({ source: "profile", profileId: profile.profileId }, game)
          : key;
      if (canonical !== key) {
        this.aliases.set(original, canonical);
        this.states.delete(key);
      }
      this.targets.set(canonical, {
        target:
          profile.kind === "account" ? { source: "profile", profileId: profile.profileId } : target,
        game,
      });
      this.states.set(canonical, { profile, error: null, loading: false, loadedAt: Date.now() });
    } catch (error) {
      if (!controller.signal.aborted && this.pending.get(key) === controller)
        this.states.set(key, {
          profile: null,
          loading: false,
          error: error instanceof Error ? error.message : "プレイヤー情報を取得できませんでした。",
          loadedAt: 0,
        });
    } finally {
      if (this.pending.get(key) === controller) {
        this.pending.delete(key);
        this.emit();
      }
    }
  }
  invalidate(filter: { game?: GameId; profileId?: string } = {}) {
    for (const [key, controller] of this.pending) {
      if (!filter.game || this.targets.get(key)?.game === filter.game) {
        controller.abort();
        this.pending.delete(key);
        this.states.delete(key);
      }
    }
    for (const [key, state] of this.states) {
      if (
        (!filter.game || this.targets.get(key)?.game === filter.game) &&
        (!filter.profileId ||
          (state.profile?.kind === "account" && state.profile.profileId === filter.profileId))
      )
        this.states.delete(key);
    }
    this.emit();
  }
  clear() {
    this.invalidate();
    this.states.clear();
    this.targets.clear();
    this.aliases.clear();
    this.emit();
  }
}
