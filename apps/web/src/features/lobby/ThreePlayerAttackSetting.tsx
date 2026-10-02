import { Label, Radio, RadioGroup } from "@heroui/react";

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
          <Radio key={value} value={value}>
            <Radio.Control>
              <Radio.Indicator />
            </Radio.Control>
            <Radio.Content>{value === "on" ? "ON" : "OFF"}</Radio.Content>
          </Radio>
        ))}
      </div>
      <p className="text-xs text-muted">
        ONでは4人が生存するシングルスで、3人が同じ相手へ攻撃する手を制限します。
      </p>
    </RadioGroup>
  );
}
