export type PurgeTargets = {
  accountId: string;
  accountIds: Set<string>;
  entries: [string, unknown][];
  ids: Set<string>;
  names: Set<string>;
  matchPlayers: Map<string, Set<string>>;
  found: boolean;
};
