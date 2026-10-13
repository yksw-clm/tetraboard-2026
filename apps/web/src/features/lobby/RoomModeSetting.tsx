import { Label, RadioGroup } from "@heroui/react";
import type { RoomMode } from "@tetraboard/protocol";
import { AppRadio } from "../../shared/ui/AppRadio";

export function RoomModeSetting({
  mode,
  disabled = false,
  onChange,
}: {
  mode: RoomMode;
  disabled?: boolean;
  onChange: (mode: RoomMode) => void;
}) {
  return (
    <RadioGroup
      className="min-w-0 m-0 p-0 border-0 flex-col! gap-[10px]! [&>.label]:text-[13px] [&>.label]:font-[650] [&>.label]:mb-0 [&>.label]:p-0"
      name="mode"
      value={mode}
      isDisabled={disabled}
      orientation="horizontal"
      onChange={(value) => {
        if (value === "singles" || value === "doubles") onChange(value);
      }}
    >
      <Label>対局モード</Label>
      <div className="grid grid-cols-2 gap-[10px] [@media(max-width:400px)]:grid-cols-1 [&_.radio]:min-w-0">
        {(["singles", "doubles"] as const).map((option) => (
          <AppRadio key={option} value={option}>
            <AppRadio.Content className="flex items-center gap-[9px] py-[13px] px-3 border border-solid border-line rounded-[11px] cursor-pointer font-normal w-full data-[selected=true]:border-entry-selection-line data-[selected=true]:bg-entry-selection-surface [&_strong]:block [&_strong]:text-[13px] [&_small]:block [&_small]:mt-[3px] [&_small]:text-muted [&_small]:text-[11px]">
              <AppRadio.Control>
                <AppRadio.Indicator />
              </AppRadio.Control>
              <span>
                <strong>{option === "singles" ? "シングルス" : "ダブルス"}</strong>
                <small>{option === "singles" ? "4人で個人戦" : "2対2のチーム戦"}</small>
              </span>
            </AppRadio.Content>
          </AppRadio>
        ))}
      </div>
    </RadioGroup>
  );
}
