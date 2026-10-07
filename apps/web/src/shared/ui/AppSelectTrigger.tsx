import { Select, cn } from "@heroui/react";
import { type ComponentPropsWithRef } from "react";

export function AppSelectTrigger({
  className,
  ...props
}: ComponentPropsWithRef<typeof Select.Trigger>) {
  return (
    <Select.Trigger
      {...props}
      className={(state) =>
        cn(
          "w-full min-w-0 min-h-11 items-center bg-surface-muted text-sm",
          typeof className === "function" ? className(state) : className,
        ) ?? ""
      }
    />
  );
}
