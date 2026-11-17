import type { MatchmakingStorage, State } from "@tetraboard/context-matchmaking";
export class DurableMatchmakingStorage implements MatchmakingStorage {
  constructor(private storage: DurableObjectStorage) {}
  load(key: string): State {
    return this.storage.kv.get<State>("state") ?? { key, waiting: [], groups: [] };
  }
  save(state: State) {
    this.storage.kv.put("state", state);
  }
  ended(operationId: string) {
    return !!this.storage.kv.get(`ended:${operationId}`);
  }
  end(operationId: string) {
    this.storage.kv.put(`ended:${operationId}`, true);
  }
  endAndSave(operationId: string, state: State) {
    this.storage.transactionSync(() => {
      this.end(operationId);
      this.save(state);
    });
  }
}
