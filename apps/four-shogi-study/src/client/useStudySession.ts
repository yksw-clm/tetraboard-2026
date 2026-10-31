import { useEffect, useRef, useState, useCallback } from "react";
import type { StudyConfig, StudyListEntry, StudyServerEvent, StudySnapshot } from "../contracts";
import { studyApi, type CommandInput, type AnalysisInput } from "./api";
import { mergeStudySnapshot, newerAnalysis } from "./snapshotState";

export function useStudySession() {
  const [snapshot, setSnapshot] = useState<StudySnapshot | null>(null);
  const [config, setConfig] = useState<StudyConfig | null>(null);
  const [library, setLibrary] = useState<StudyListEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [connected, setConnected] = useState(false);
  const alive = useRef(true);
  const busy = useRef(false);
  const latest = useRef(snapshot);
  latest.current = snapshot;
  const accept = useCallback((next: StudySnapshot, expectedStudyId?: string) => {
    if (!alive.current) return;
    setSnapshot((current) =>
      expectedStudyId && current?.study.id !== expectedStudyId
        ? current
        : mergeStudySnapshot(current, next),
    );
  }, []);
  const refreshLibrary = useCallback(async () => {
    const studies = await studyApi.list();
    if (alive.current) setLibrary(studies);
  }, []);

  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    void Promise.all([studyApi.config(), studyApi.list()])
      .then(async ([configuration, studies]) => {
        if (cancelled) return;
        setConfig(configuration);
        setLibrary(studies);
        const current = studies.length
          ? await studyApi.get(studies[0].id)
          : await studyApi.create({});
        if (cancelled) return;
        accept(current);
        await refreshLibrary();
      })
      .catch((cause) => {
        if (!cancelled) setError(String(cause instanceof Error ? cause.message : cause));
      });
    return () => {
      cancelled = true;
      alive.current = false;
    };
  }, [accept, refreshLibrary]);

  const studyId = snapshot?.study.id;
  useEffect(() => {
    if (!studyId) return;
    const events = new EventSource(`/api/events?studyId=${encodeURIComponent(studyId)}`);
    let disposed = false,
      opened = false,
      verified = false;
    const active = () => !disposed && latest.current?.study.id === studyId;
    events.onopen = () => {
      if (!active()) return;
      opened = true;
      verified = false;
      setConnected(false);
    };
    events.onerror = () => {
      if (!active()) return;
      opened = false;
      verified = false;
      setConnected(false);
    };
    events.onmessage = (message) => {
      if (!active() || !opened) return;
      try {
        const event = JSON.parse(message.data) as StudyServerEvent;
        if (event.type === "snapshot" && event.snapshot.study.id === studyId) {
          if (event.snapshot.study.revision < (latest.current?.study.revision ?? 0)) return;
          accept(event.snapshot, studyId);
          verified = true;
          setConnected(true);
        } else if (verified && event.type === "analysis" && event.studyId === studyId) {
          setSnapshot((current) => {
            if (
              !current ||
              current.study.id !== studyId ||
              event.analysis.nodeId !== current.study.currentNodeId ||
              event.analysis.modelGeneration !== current.study.settings.modelGeneration ||
              event.analysis.stateHash !== current.position.stateHash
            )
              return current;
            return { ...current, analysis: newerAnalysis(current.analysis, event.analysis) };
          });
        } else if (event.type === "error") setError(event.message);
      } catch {
        verified = false;
        setConnected(false);
        setError("解析結果の読み込みに失敗しました。検討を開き直してください。");
      }
    };
    return () => {
      disposed = true;
      events.close();
      setConnected(false);
    };
  }, [studyId, accept]);

  async function run(operation: () => Promise<StudySnapshot>, replace = false): Promise<boolean> {
    if (busy.current) return false;
    busy.current = true;
    const sourceId = latest.current?.study.id;
    setPending(true);
    setError(null);
    try {
      const next = await operation();
      if (replace || latest.current?.study.id === sourceId)
        accept(next, replace ? undefined : sourceId);
      await refreshLibrary();
      return true;
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : String(cause));
      if (sourceId && latest.current?.study.id === sourceId) {
        try {
          accept(await studyApi.get(sourceId), sourceId);
        } catch {
          /* 編集内容は現在表示している局面に残します。 */
        }
      }
      return false;
    } finally {
      busy.current = false;
      if (alive.current) setPending(false);
    }
  }
  return {
    snapshot,
    config,
    library,
    pending,
    connected,
    error,
    clearError: () => setError(null),
    open: (id: string) =>
      run(async () => {
        const current = latest.current;
        if (current && current.study.id !== id) {
          if (current.live?.follow)
            await studyApi.command(current, { type: "liveFollow", enabled: false });
          else if (current.study.playEnabled)
            await studyApi.command(current, { type: "pausePlay" });
          else if (current.analysis?.status === "running")
            await studyApi.analysis(current, { command: "pause" });
        }
        return studyApi.get(id);
      }, true),
    create: (input: Parameters<typeof studyApi.create>[0]) =>
      run(() => studyApi.create(input), true),
    importStudy: (input: Parameters<typeof studyApi.import>[0]) =>
      run(() => studyApi.import(input), true),
    watch: (url: string) => run(() => studyApi.watch(url), true),
    command: (command: CommandInput) => {
      const current = latest.current;
      return current
        ? run(() => studyApi.command(current, command), command.type === "setup")
        : Promise.resolve(false);
    },
    analyze: (command: AnalysisInput) => {
      const current = latest.current;
      return current ? run(() => studyApi.analysis(current, command)) : Promise.resolve(false);
    },
  };
}
export type StudySession = ReturnType<typeof useStudySession>;
