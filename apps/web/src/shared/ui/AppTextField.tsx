import { Description, FieldError, Input, Label, TextField, cn } from "@heroui/react";
import { type ComponentPropsWithRef } from "react";

export function AppTextField({ className, ...props }: ComponentPropsWithRef<typeof TextField>) {
  return (
    <TextField
      {...props}
      className={(state) =>
        cn(
          "flex min-w-0 flex-col gap-2",
          typeof className === "function" ? className(state) : className,
        ) ?? ""
      }
    />
  );
}

function AppFieldLabel({ className, ...props }: ComponentPropsWithRef<typeof Label>) {
  return <Label {...props} className={cn("text-[13px] font-[650] text-ink", className)} />;
}

function AppInput({ className, ...props }: ComponentPropsWithRef<typeof Input>) {
  return (
    <Input
      {...props}
      className={(state) =>
        cn(
          "box-border h-auto min-h-12 w-full min-w-0 rounded-control border border-solid border-input bg-surface-input px-[13px] py-[10px] text-base text-ink shadow-none placeholder:text-muted focus-visible:outline-[3px] focus-visible:outline-focus focus-visible:outline-offset-2 disabled:bg-surface-muted disabled:text-muted data-[invalid=true]:border-danger",
          typeof className === "function" ? className(state) : className,
        ) ?? ""
      }
    />
  );
}

function AppFieldDescription({ className, ...props }: ComponentPropsWithRef<typeof Description>) {
  return <Description {...props} className={cn("text-xs text-muted", className)} />;
}

// エラーを入力欄の説明に結び付け、HeroUIの検証状態を引き継ぎます。
function AppFieldError({ className, ...props }: ComponentPropsWithRef<typeof FieldError>) {
  return (
    <FieldError
      {...props}
      className={(state) =>
        cn("text-xs text-danger", typeof className === "function" ? className(state) : className) ??
        ""
      }
    />
  );
}

AppTextField.Label = AppFieldLabel;
AppTextField.Input = AppInput;
AppTextField.Description = AppFieldDescription;
AppTextField.Error = AppFieldError;
