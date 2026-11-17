import type { State, TournamentQueueStorage } from "@tetraboard/context-tournament";
export class DurableTournamentStorage implements TournamentQueueStorage {
  constructor(private storage: DurableObjectStorage) {}
  current() {
    return this.storage.kv.get<State>("state");
  }
  load(key: string): State {
    const state = this.current() ?? { key, waiting: [], groups: [] };
    if (state.key !== key) throw new Error("Tournament coordinator identity mismatch");
    return state;
  }
  save(state: State) {
    this.storage.kv.put("state", state);
  }
  cancelled(key: string) {
    return !!this.storage.kv.get(key);
  }
  cancel(key: string) {
    this.storage.kv.put(key, true);
  }
  async setAlarm(at: number) {
    await this.storage.setAlarm(at);
  }
  async deleteAlarm() {
    await this.storage.deleteAlarm();
  }
}
