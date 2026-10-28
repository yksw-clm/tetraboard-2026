import type {
  StudySnapshot,
  StudyConfig,
  StudyListEntry,
  StudyCommand,
  StudyAnalysisCommand,
} from "../contracts";
import type { Side } from "@tetraboard/four-shogi";
import type { StudySettings } from "../shared/model";

type WithoutRevision<T> = T extends unknown ? Omit<T, "expectedRevision"> : never;
export type CommandInput = WithoutRevision<StudyCommand>;
export type AnalysisInput = WithoutRevision<StudyAnalysisCommand>;

async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(
    path,
    body === undefined
      ? undefined
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      typeof data.error === "string"
        ? data.error
        : typeof data.message === "string"
          ? data.message
          : "操作を完了できませんでした。もう一度お試しください。",
    );
  return data as T;
}
export const studyApi = {
  config: () => request<StudyConfig>("/api/config"),
  list: () => request<StudyListEntry[]>("/api/studies"),
  get: (id: string) => request<StudySnapshot>(`/api/studies/${encodeURIComponent(id)}`),
  create: (input: {
    title?: string;
    cpuSide?: Side;
    threePlayerAttackProhibited?: boolean;
    settings?: Partial<StudySettings>;
  }) => request<StudySnapshot>("/api/studies", input),
  command: (snapshot: StudySnapshot, command: CommandInput) =>
    request<StudySnapshot>(`/api/studies/${encodeURIComponent(snapshot.study.id)}/commands`, {
      ...command,
      expectedRevision: snapshot.study.revision,
    }),
  analysis: (snapshot: StudySnapshot, command: AnalysisInput) =>
    request<StudySnapshot>(`/api/studies/${encodeURIComponent(snapshot.study.id)}/analysis`, {
      ...command,
      expectedRevision: snapshot.study.revision,
    }),
  import: (input: { url: string } | { data: unknown }) =>
    request<StudySnapshot>("/api/import", input),
  watch: (url: string) => request<StudySnapshot>("/api/live", { url }),
};
