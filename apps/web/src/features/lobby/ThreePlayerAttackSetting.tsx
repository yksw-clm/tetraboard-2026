import { AppRadio } from "../../shared/ui/AppRadio";
import { Label, RadioGroup } from "@heroui/react";

export function ThreePlayerAttackSetting({
  prohibited,
  disabled,
  onChange,
}: {
  prohibited: boolean;
  disabled: boolean;
  onChange: (prohibited: boolean) => void;
}) {
  return (
    <RadioGroup
      value={prohibited ? "on" : "off"}
      onChange={(value) => {
        if (value === "on" || value === "off") onChange(value === "on");
      }}
      isDisabled={disabled}
      orientation="horizontal"
      className="min-w-0 gap-2 [&>.label]:text-[13px] [&>.label]:font-[650]"
    >
      <Label>三人攻撃禁止</Label>
      <div className="flex gap-4">
        {(["on", "off"] as const).map((value) => (
          <AppRadio key={value} value={value}>
            <AppRadio.Content className="flex items-center gap-[6px]">
              <AppRadio.Control>
                <AppRadio.Indicator />
              </AppRadio.Control>
              {value === "on" ? "ON" : "OFF"}
            </AppRadio.Content>
          </AppRadio>
        ))}
      </div>
      <p className="text-xs text-muted">
        ONでは4人が生存するシングルスで、3人が同じ相手へ攻撃する手を制限します。
      </p>
    </RadioGroup>
  );
}
