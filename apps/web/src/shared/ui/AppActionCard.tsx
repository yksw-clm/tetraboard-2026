import { type ComponentProps } from "react";
import { AppButton } from "./AppButton";
import { AppCard } from "./AppCard";
import { AppIcon, type AppIconName } from "./AppIcon";

export function AppActionCard({
  title,
  description,
  icon,
  onPress,
}: {
  title: string;
  description: string;
  icon: AppIconName;
  onPress: ComponentProps<typeof AppButton>["onPress"];
}) {
  return (
    <AppCard className="p-0 border-0 shadow-none">
      <AppButton
        appearance="secondary"
        onPress={onPress}
        className="w-full h-auto justify-start whitespace-normal gap-4 min-w-0 py-[14px] px-6 rounded-panel text-left text-ink font-normal leading-[1.6] shadow-panel hover:border-action-card-line-hover hover:shadow-action-card-hover [@media(max-width:650px)]:px-[18px] [@media(max-width:650px)]:gap-[13px]"
      >
        <span className="grid place-items-center shrink-0 size-11 rounded-[13px] text-brand-hover bg-action-card-icon">
          <AppIcon name={icon} />
        </span>
        <span className="flex-1 min-w-0">
          <strong className="block text-base [@media(max-width:650px)]:text-[15px]">{title}</strong>
          <span className="block mt-[3px] text-muted text-xs">{description}</span>
        </span>
        <AppIcon name="arrow" className="text-action-card-arrow" />
      </AppButton>
    </AppCard>
  );
}
