import type { CpuLevel } from "@tetraboard/protocol";
import { AppButton } from "../../shared/ui/AppButton";
import { updatingSettingsButtonClasses } from "./roomSettingsPresentation";

export function CpuLevelSelector({
  label,
  level,
  disabled,
  pendingLevel,
  updating = false,
  onChange,
}: {
  label: string;
  level: CpuLevel;
  disabled: boolean;
  pendingLevel?: CpuLevel;
  updating?: boolean;
  onChange: (level: CpuLevel) => void;
}) {
  return (
    <div className="flex rounded-lg bg-surface-muted p-[2px]" role="group" aria-label={label}>
      {([1, 2] as const).map((value) => (
        <AppButton
          key={value}
          size="compact"
          appearance="quiet"
          className={`text-[11px] h-6 min-h-6 min-w-[38px] bg-transparent hover:bg-surface-hover data-[hovered=true]:bg-surface-hover rounded-[6px] py-[2px] px-2 text-muted aria-pressed:bg-white aria-pressed:shadow-[0_1px_4px_#2138271a] aria-pressed:text-brand ${updating ? updatingSettingsButtonClasses : ""}`}
          aria-pressed={level === value}
          isDisabled={disabled}
          isPending={pendingLevel === value}
          onPress={() => onChange(value)}
        >
          Lv{value}
        </AppButton>
      ))}
    </div>
  );
}
