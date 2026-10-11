import { AppRadio } from "../../shared/ui/AppRadio";
import { Label, RadioGroup } from "@heroui/react";

export function GomokuForbiddenControl({
  enabled,
  disabled,
  onChange,
}: {
  enabled: boolean;
  disabled: boolean;
  onChange: (enabled: boolean) => void;
}) {
  return (
    <RadioGroup
      value={enabled ? "on" : "off"}
      onChange={(value) => {
        if (value === "on" || value === "off") onChange(value === "on");
      }}
      isDisabled={disabled}
      orientation="horizontal"
      className="min-w-0 gap-2 [&>.label]:text-[13px] [&>.label]:font-[650]"
    >
      <Label>禁手ルール</Label>
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
      <p className="text-xs text-muted">ONでは黒の三三・四四・長連を禁止します。</p>
    </RadioGroup>
  );
}
