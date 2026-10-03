import { Label, ListBox, Select } from "@heroui/react";
import {
  roomMainTimePresets,
  roomByoyomiPresets,
  roomTimeControlSchema,
  type RoomTimeControl,
} from "@tetraboard/protocol";
import { appThemeClasses, type AppTheme } from "../../shared/ui/appTheme";

export function TimeControlSetting({
  timeControl,
  onChange,
  disabled = false,
  theme = "default",
}: {
  timeControl: RoomTimeControl;
  onChange: (value: RoomTimeControl) => void;
  disabled?: boolean;
  theme?: AppTheme;
}) {
  return (
    <div>
      <div className="grid grid-cols-2 gap-3 min-w-0">
        {(
          [
            {
              field: "mainTimeMs",
              label: "持ち時間",
              presets: roomMainTimePresets,
              unit: "分",
              divisor: 60_000,
              other: "byoyomiMs",
            },
            {
              field: "byoyomiMs",
              label: "秒読み",
              presets: roomByoyomiPresets,
              unit: "秒",
              divisor: 1000,
              other: "mainTimeMs",
            },
          ] as const
        ).map(({ field, label, presets, unit, divisor, other }) => (
          <Select
            key={field}
            value={String(timeControl[field])}
            isDisabled={disabled}
            className="w-full min-w-0"
            onChange={(key) => {
              if (key === null) return;
              const parsed = roomTimeControlSchema.safeParse({
                ...timeControl,
                [field]: Number(key),
              });
              if (parsed.success) onChange(parsed.data);
            }}
          >
            <Label className="text-xs font-bold text-muted">{label}</Label>
            <Select.Trigger className="w-full min-w-0 min-h-11 bg-surface-muted text-sm">
              <Select.Value />
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover
              className={`app-theme ${appThemeClasses[theme]} bg-white text-ink text-sm`}
            >
              <ListBox>
                {presets.map((value) => {
                  const text = value === 0 ? "なし" : `${value / divisor}${unit}`;
                  return (
                    <ListBox.Item
                      key={value}
                      id={String(value)}
                      textValue={text}
                      isDisabled={value === 0 && timeControl[other] === 0}
                      className="min-h-11"
                    >
                      {text}
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  );
                })}
              </ListBox>
            </Select.Popover>
          </Select>
        ))}
      </div>
      <p className="mt-2 text-xs text-muted">持ち時間と秒読みの両方をなしにはできません。</p>
    </div>
  );
}
