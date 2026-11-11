import { AppIcon } from "../../shared/ui/AppIcon";
import { AppButton } from "../../shared/ui/AppButton";
import type { MatchKind } from "@tetraboard/protocol";
import { MatchKindBadge } from "../../shared/ui/MatchKindBadge";

export function ViewerControls({
  label,
  hideLabelOnMobile = false,
  onRotate,
  rotationDegrees = 90,
  matchKind,
}: {
  label: "観戦中" | "棋譜閲覧中";
  hideLabelOnMobile?: boolean;
  onRotate: () => void;
  rotationDegrees?: 90 | 180;
  matchKind?: MatchKind;
}) {
  return (
    <div className="ml-auto flex shrink-0 items-center gap-1.5">
      {matchKind && <MatchKindBadge kind={matchKind} />}
      <span
        className={`text-muted text-xs whitespace-nowrap ${hideLabelOnMobile ? "[@media(max-width:767px)]:hidden" : ""}`}
      >
        {label}
      </span>
      <span title={`盤面を時計回りに${rotationDegrees}度回転`} className="shrink-0">
        <AppButton
          isIconOnly
          appearance="secondary"
          size="compact"
          className="w-[38px] min-w-[38px] h-[38px] min-h-[38px] p-0"
          aria-label={`盤面を時計回りに${rotationDegrees}度回転`}
          onPress={onRotate}
        >
          <AppIcon name="rotateClockwise" width="22" height="22" />
        </AppButton>
      </span>
    </div>
  );
}
