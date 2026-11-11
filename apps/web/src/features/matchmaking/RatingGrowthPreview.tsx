import { useEffect, useState, useSyncExternalStore } from "react";
import { AppIcon } from "../../shared/ui/AppIcon";

const ratings = [1500, 1512, 1528, 1547, 1565, 1582, 1600];
const motionQuery = "(prefers-reduced-motion: reduce)";
const readReducedMotion = () => window.matchMedia(motionQuery).matches;
function subscribeReducedMotion(callback: () => void) {
  const media = window.matchMedia(motionQuery);
  media.addEventListener("change", callback);
  return () => media.removeEventListener("change", callback);
}

export function RatingGrowthPreview() {
  const reducedMotion = useSyncExternalStore(subscribeReducedMotion, readReducedMotion, () => true);
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (reducedMotion || step === ratings.length - 1) return;
    const timer = window.setTimeout(() => setStep((previous) => previous + 1), 1000);
    return () => window.clearTimeout(timer);
  }, [reducedMotion, step]);
  const rating = ratings[reducedMotion ? ratings.length - 1 : step]!;
  const animate = !reducedMotion && step > 0;

  return (
    <div className="flex flex-col items-center gap-1">
      <div
        role="img"
        aria-label="レートのイメージ：1500から1600へ上がる演出"
        className="flex items-center gap-4 py-1"
      >
        <span className="grid size-16 place-items-center rounded-full bg-brand/10 text-brand">
          <AppIcon name="trophy" className="size-9" />
        </span>
        <span aria-hidden="true" className="relative mr-10 inline-flex">
          <span
            key={reducedMotion ? "static" : `rating-${step}`}
            className={`inline-block w-[4ch] text-left text-[40px] font-bold leading-none tabular-nums text-brand ${animate ? "motion-safe:[animation:rating-preview-bounce_360ms_ease-out]" : ""}`}
          >
            {rating}
          </span>
          {animate && (
            <span
              key={`gain-${step}`}
              className="absolute left-full top-1 ml-2 text-sm font-bold tabular-nums text-emerald-700 motion-safe:[animation:rating-preview-gain_900ms_ease-out_both]"
            >
              +{rating - ratings[step - 1]!}
            </span>
          )}
        </span>
      </div>
      <p className="text-xs text-muted">レートのイメージ</p>
    </div>
  );
}
