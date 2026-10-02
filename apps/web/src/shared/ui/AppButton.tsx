import { Button, cn } from "@heroui/react";
import { type ComponentPropsWithRef } from "react";
import { Link } from "react-router";

type Appearance = "primary" | "secondary" | "quiet" | "danger";
type Size = "default" | "compact";

const appearances = {
  primary:
    "border-transparent bg-brand text-white shadow-action [&:hover:not(:disabled)]:bg-brand-hover data-[hovered=true]:bg-brand-hover",
  secondary:
    "border-line bg-white text-ink-secondary [&:hover:not(:disabled)]:border-line-hover [&:hover:not(:disabled)]:bg-surface-hover data-[hovered=true]:bg-surface-hover",
  quiet:
    "border-transparent bg-transparent text-muted [&:hover:not(:disabled)]:bg-surface-muted [&:hover:not(:disabled)]:text-ink data-[hovered=true]:bg-surface-muted",
  danger:
    "border-transparent bg-danger text-white [&:hover:not(:disabled)]:bg-danger-hover data-[hovered=true]:bg-danger-hover",
} satisfies Record<Appearance, string>;
const sizes = {
  default: "min-h-[42px] gap-[9px] px-[18px] py-2 text-[15px]",
  compact: "min-h-[38px] gap-[7px] px-[14px] py-2 text-[12px]",
} satisfies Record<Size, string>;

function buttonClasses(appearance: Appearance, size: Size) {
  return cn(
    "inline-flex h-auto shrink-0 items-center justify-center rounded-control border border-solid font-[650] leading-normal whitespace-nowrap no-underline transition-colors duration-150 cursor-pointer focus-visible:outline-[3px] focus-visible:outline-focus focus-visible:outline-offset-4 disabled:cursor-default disabled:opacity-50 data-[disabled=true]:cursor-default data-[disabled=true]:opacity-50 motion-reduce:transition-none",
    appearances[appearance],
    sizes[size],
  );
}

type AppButtonProps = Omit<ComponentPropsWithRef<typeof Button>, "variant" | "size"> & {
  appearance?: Appearance;
  size?: Size;
};

export function AppButton({
  appearance = "primary",
  size = "default",
  className,
  ...props
}: AppButtonProps) {
  return (
    <Button
      {...props}
      className={(state) =>
        cn(
          buttonClasses(appearance, size),
          typeof className === "function" ? className(state) : className,
        ) ?? ""
      }
    />
  );
}

type AppButtonLinkProps = ComponentPropsWithRef<typeof Link> & {
  appearance?: Appearance;
  size?: Size;
};

export function AppButtonLink({
  appearance = "secondary",
  size = "default",
  className,
  ...props
}: AppButtonLinkProps) {
  return <Link {...props} className={cn(buttonClasses(appearance, size), className)} />;
}
