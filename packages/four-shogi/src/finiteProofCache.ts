import type { AnalysisPosition } from "./analysis";
import type { Side } from "./types";
import type { SafetyNode } from "./finiteSurvival";

export type FiniteCacheStats = {
  lookups: number;
  hits: number;
  dependencyMisses: number;
  stores: number;
  evictions: number;
  importedNodes: number;
  bytes: number;
  peakBytes: number;
};
export type FiniteProofCache = Readonly<{ stats: FiniteCacheStats; clear(): void }>;
type Entry = { node: SafetyNode; bytes: number };
type Data = {
  scope: string;
  root: Side;
  maxBytes: number;
  entries: Map<string, Entry>;
  stats: FiniteCacheStats;
};
const caches = new WeakMap<FiniteProofCache, Data>();
const scope = (p: AnalysisPosition, root: Side) =>
  `${p.analysisStateVersion}/${p.ruleProfileId}/${p.rulesVersion}/finite-survival-v1/all-opponents/${root}/${p.stateHash}`;
const clone = (n: SafetyNode): SafetyNode => ({
  ...n,
  legal: [...n.legal],
  edges: n.edges.map((e) => ({ ...e })),
});
const size = (n: SafetyNode) => 384 + n.legal.length * 24 + n.edges.length * 160;
export function createFiniteProofCache(
  position: AnalysisPosition,
  root: Side,
  maxBytes = 1048576,
): FiniteProofCache {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw Error("証明キャッシュ容量が不正です");
  const stats: FiniteCacheStats = {
    lookups: 0,
    hits: 0,
    dependencyMisses: 0,
    stores: 0,
    evictions: 0,
    importedNodes: 0,
    bytes: 0,
    peakBytes: 0,
  };
  const data: Data = { scope: scope(position, root), root, maxBytes, entries: new Map(), stats };
  const cache = Object.freeze({
    get stats() {
      return { ...stats };
    },
    clear() {
      data.entries.clear();
      stats.bytes = 0;
    },
  });
  caches.set(cache, data);
  return cache;
}
export function requireFiniteCache(
  cache: FiniteProofCache,
  position: AnalysisPosition,
  root: Side,
) {
  const d = caches.get(cache);
  if (!d || d.scope !== scope(position, root))
    throw Error("証明キャッシュのジョブ・履歴・本人が一致しません");
}
export function readFiniteCache(
  cache: FiniteProofCache,
  key: string,
  limits: { nodes: number; bytes: number; work: number; available: () => boolean },
): { nodes: Record<string, SafetyNode>; bytes: number } | null {
  const d = caches.get(cache)!;
  d.stats.lookups++;
  if (!d.entries.has(key)) return null;
  const found = new Map<string, Entry>(),
    pending = [key];
  let bytes = 0;
  while (pending.length) {
    if (!limits.available()) return null;
    const k = pending.pop()!;
    if (found.has(k)) continue;
    const e = d.entries.get(k);
    if (!e) {
      d.stats.dependencyMisses++;
      return null;
    }
    found.set(k, e);
    bytes += e.bytes;
    if (found.size > limits.nodes || found.size > limits.work || bytes > limits.bytes) return null;
    for (const edge of e.node.edges) pending.push(edge.child);
  }
  d.stats.hits++;
  d.stats.importedNodes += found.size;
  return { nodes: Object.fromEntries([...found].map(([k, e]) => [k, clone(e.node)])), bytes };
}
export function rememberFiniteNode(
  cache: FiniteProofCache,
  key: string,
  node: SafetyNode,
  nodes: Record<string, SafetyNode>,
) {
  if (node.status === "unknown") return;
  const d = caches.get(cache)!;
  const universal = node.turn === d.root ? node.status === "unsafe" : node.status === "safe";
  const copy = clone(node);
  if (node.reason === "searched" && !universal)
    copy.edges = copy.edges.filter((e) => nodes[e.child]?.status === node.status).slice(0, 1);
  const bytes = size(copy);
  if (bytes > d.maxBytes || d.entries.has(key)) return;
  while (d.entries.size && d.stats.bytes + bytes > d.maxBytes) {
    const first = d.entries.keys().next().value!;
    d.stats.bytes -= d.entries.get(first)!.bytes;
    d.entries.delete(first);
    d.stats.evictions++;
  }
  d.entries.set(key, { node: copy, bytes });
  d.stats.bytes += bytes;
  d.stats.peakBytes = Math.max(d.stats.peakBytes, d.stats.bytes);
  d.stats.stores++;
}
