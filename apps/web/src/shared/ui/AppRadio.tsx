import { Radio, cn } from "@heroui/react";
import { type ComponentPropsWithRef } from "react";

function AppRadioControl({ className, ...props }: ComponentPropsWithRef<typeof Radio.Control>) {
  return (
    <Radio.Control
      {...props}
      className={cn(
        "border border-solid [.radio:not([data-selected]):not(:has(:checked,[aria-checked=true]))_&]:border-muted [.radio:not([data-selected]):not(:has(:checked,[aria-checked=true]))_&]:bg-white",
        className,
      )}
    />
  );
}

export function AppRadio(props: ComponentPropsWithRef<typeof Radio>) {
  return <Radio {...props} />;
}

AppRadio.Content = Radio.Content;
AppRadio.Control = AppRadioControl;
AppRadio.Indicator = Radio.Indicator;
