import { Tabs, cn } from "@heroui/react";
import { type ComponentPropsWithRef } from "react";

function AppTabList({ className, ...props }: ComponentPropsWithRef<typeof Tabs.List>) {
  return (
    <Tabs.List
      {...props}
      className={cn("flex gap-1 rounded-full bg-surface-muted p-1", className)}
    />
  );
}

function AppTab({ className, ...props }: ComponentPropsWithRef<typeof Tabs.Tab>) {
  return (
    <Tabs.Tab
      {...props}
      className={cn(
        "relative isolate flex min-h-[38px] flex-1 items-center justify-center gap-2 rounded-full px-3 text-[13px] font-[650] text-muted data-[selected=true]:text-brand focus-visible:outline-[3px] focus-visible:outline-focus focus-visible:outline-offset-2",
        className,
      )}
    />
  );
}

function AppTabIndicator({ className, ...props }: ComponentPropsWithRef<typeof Tabs.Indicator>) {
  return (
    <Tabs.Indicator
      {...props}
      className={cn(
        "-z-10 rounded-full bg-white shadow-panel motion-reduce:transition-none",
        className,
      )}
    />
  );
}

function AppTabPanel({ className, ...props }: ComponentPropsWithRef<typeof Tabs.Panel>) {
  return (
    <Tabs.Panel {...props} className={cn("min-h-0 min-w-0 data-[inert=true]:hidden", className)} />
  );
}

export function AppTabs(props: ComponentPropsWithRef<typeof Tabs>) {
  return <Tabs {...props} />;
}

AppTabs.List = AppTabList;
AppTabs.Tab = AppTab;
AppTabs.Indicator = AppTabIndicator;
AppTabs.Panel = AppTabPanel;
