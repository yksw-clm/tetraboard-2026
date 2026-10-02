import { AppCard } from "../../shared/ui/AppCard";
import { AppButton } from "../../shared/ui/AppButton";
import { ListBox, Select } from "@heroui/react";
import { appThemeClasses, type AppTheme } from "../../shared/ui/appTheme";

const stepButtonClasses =
  "shrink-0 basis-8 w-8 min-w-8 h-[34px] min-h-[34px] p-0 text-brand [@media(max-width:767px)]:basis-6 [@media(max-width:767px)]:w-6 [@media(max-width:767px)]:min-w-6 [@media(max-width:767px)]:h-6 [@media(max-width:767px)]:min-h-6 [@media(max-width:767px)]:text-xs";

export function ReplayCard({
  replay,
  theme = "default",
}: {
  replay: { frames: readonly { label: string }[]; index: number; select: (index: number) => void };
  theme?: AppTheme;
}) {
  return (
    <AppCard
      className="flex flex-row items-center gap-1 p-1 border border-solid border-line rounded-xl bg-[#ffffffed] min-w-0 shadow-none [@media(min-width:1280px)]:absolute [@media(min-width:1280px)]:right-0 [@media(min-width:1280px)]:bottom-0 [@media(min-width:1280px)]:z-[1] [@media(min-width:1280px)]:w-[310px] [@media(min-width:1280px)]:shrink-0 [@media(max-width:1279px)]:col-start-2 [@media(max-width:1279px)]:w-[min(100%,320px)] [@media(max-width:1279px)]:justify-self-center [@media(max-width:767px)]:w-[min(100%,200px)] [@media(max-width:767px)]:h-7 [@media(max-width:767px)]:p-px [@media(max-width:767px)]:gap-0 [@media(max-width:767px)]:rounded-lg"
      aria-label="棋譜"
    >
      <AppButton
        className={stepButtonClasses}
        size="compact"
        isIconOnly
        appearance="quiet"
        aria-label="棋譜を1つ戻る"
        isDisabled={replay.index <= 0}
        onPress={() => replay.select(replay.index - 1)}
      >
        ←
      </AppButton>
      <Select
        aria-label="棋譜の局面"
        className="flex-1 min-w-0"
        value={String(replay.index)}
        onChange={(key) => replay.select(Number(key))}
      >
        <Select.Trigger className="w-full min-w-0 h-[34px] min-h-[34px] px-2 py-0 items-center text-[13px] bg-surface-muted [@media(max-width:767px)]:h-6 [@media(max-width:767px)]:min-h-6 [@media(max-width:767px)]:pl-1 [@media(max-width:767px)]:pr-[14px] [@media(max-width:767px)]:text-[11px] [@media(max-width:767px)]:rounded-[6px]">
          <Select.Value className="leading-5 [@media(max-width:767px)]:text-xs [@media(max-width:767px)]:leading-[18px]" />
          <Select.Indicator className="[@media(max-width:767px)]:size-[10px] [@media(max-width:767px)]:right-[3px]" />
        </Select.Trigger>
        <Select.Popover
          className={`app-theme ${appThemeClasses[theme]} box-border min-w-[200px] max-h-[min(360px,60dvh)] bg-white text-[13px] leading-normal [&_*]:box-border`}
          placement="top"
        >
          <ListBox className="max-h-[min(350px,55dvh)] overflow-y-auto m-0 list-none">
            {replay.frames.map((frame, index) => (
              <ListBox.Item
                className="min-h-[34px] rounded-lg"
                key={index}
                id={String(index)}
                textValue={frame.label}
              >
                {frame.label}
                <ListBox.ItemIndicator />
              </ListBox.Item>
            ))}
          </ListBox>
        </Select.Popover>
      </Select>
      <AppButton
        className={stepButtonClasses}
        size="compact"
        isIconOnly
        appearance="quiet"
        aria-label="棋譜を1つ進む"
        isDisabled={replay.index >= replay.frames.length - 1}
        onPress={() => replay.select(replay.index + 1)}
      >
        →
      </AppButton>
    </AppCard>
  );
}
