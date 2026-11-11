import { useCallback, useEffect, useRef, useState } from "react";

export type PreviewRankingMetric = "victories" | "rating";

export function useRankingRotation(available: boolean, blocked: boolean, reducedMotion: boolean) {
  const [metric, setMetric] = useState<PreviewRankingMetric>("victories");
  const [phase, setPhase] = useState<"idle" | "out" | "in">("idle");
  const [paused, setPaused] = useState(false);
  const [hidden, setHidden] = useState(() => document.hidden);
  const target = useRef<PreviewRankingMetric>("victories");
  const select = useCallback(
    (next: PreviewRankingMetric) => {
      target.current = next;
      if (reducedMotion) {
        setMetric(next);
        setPhase("idle");
      } else setPhase("out");
    },
    [reducedMotion],
  );
  useEffect(() => {
    const visible = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", visible);
    return () => document.removeEventListener("visibilitychange", visible);
  }, []);
  useEffect(() => {
    if (phase === "idle") return;
    const timer = window.setTimeout(
      () => {
        if (phase === "out") {
          setMetric(target.current);
          setPhase(reducedMotion ? "idle" : "in");
        } else setPhase("idle");
      },
      reducedMotion ? 0 : phase === "out" ? 100 : 150,
    );
    return () => window.clearTimeout(timer);
  }, [phase, reducedMotion]);
  useEffect(() => {
    if (!available || blocked || paused || hidden || phase !== "idle") return;
    const timer = window.setTimeout(
      () => select(metric === "victories" ? "rating" : "victories"),
      10_000,
    );
    return () => window.clearTimeout(timer);
  }, [available, blocked, paused, hidden, phase, metric, select]);
  return { metric, phase, paused, select, togglePaused: () => setPaused((value) => !value) };
}
