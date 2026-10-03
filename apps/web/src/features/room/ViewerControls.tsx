import { AppIcon } from "../../shared/ui/AppIcon";
import type { ReactNode } from "react";
import { AppButton } from "../../shared/ui/AppButton";

export function ViewerControls({
  label,
  onRotate,
  children,
}: {
  label: "観戦中" | "棋譜閲覧中";
  onRotate: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="flex w-full h-[38px] min-h-[38px] items-center justify-between gap-2">
      <span className="text-muted text-xs whitespace-nowrap">{label}</span>
      {children}
      <span title="盤面を時計回りに90度回転" className="shrink-0">
        <AppButton
          isIconOnly
          appearance="secondary"
          size="compact"
          className="w-[38px] min-w-[38px] h-[38px] min-h-[38px] p-0"
          aria-label="盤面を時計回りに90度回転"
          onPress={onRotate}
        >
          <AppIcon name="rotateClockwise" width="22" height="22" />
        </AppButton>
      </span>
    </div>
  );
}
