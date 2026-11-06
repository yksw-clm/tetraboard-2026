import { AppIcon } from "../../shared/ui/AppIcon";
import { AppButton } from "../../shared/ui/AppButton";

export function ViewerControls({
  label,
  onRotate,
  rotationDegrees = 90,
}: {
  label: "観戦中" | "棋譜閲覧中";
  onRotate: () => void;
  rotationDegrees?: 90 | 180;
}) {
  return (
    <div className="ml-auto flex shrink-0 items-center gap-1.5">
      <span className="text-muted text-xs whitespace-nowrap">{label}</span>
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
