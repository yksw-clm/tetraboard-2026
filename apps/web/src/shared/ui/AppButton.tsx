import { Button, cn } from "@heroui/react";
import { type ComponentPropsWithRef } from "react";
import { Link } from "react-router";
import { AppPendingIndicator, pendingButtonClasses } from "./AppPendingIndicator";

type Appearance = "primary" | "secondary" | "quiet" | "danger";
type Size = "default" | "compact";

const appearances = {
  primary:
    "border-transparent bg-primary text-primary-foreground shadow-action [&:hover:not(:disabled)]:bg-primary-hover data-[hovered=true]:bg-primary-hover",
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
  isPending = false,
  children,
  ...props
}: AppButtonProps) {
  return (
    <Button
      {...props}
      isPending={isPending}
      className={(state) =>
        cn(
          buttonClasses(appearance, size),
          pendingButtonClasses,
          typeof className === "function" ? className(state) : className,
        ) ?? ""
      }
    >
      {(state) => (
        <>
          {typeof children === "function" ? children(state) : children}
          {isPending && (
            <AppPendingIndicator
              className={
                appearance === "primary"
                  ? "text-primary-foreground"
                  : appearance === "danger"
                    ? "text-white"
                    : "text-ink-secondary"
              }
            />
          )}
        </>
      )}
    </Button>
  );
}

type AppButtonLinkProps = ComponentPropsWithRef<typeof Link> & {
  appearance?: Appearance;
  size?: Size;
  isPending?: boolean;
};

export function AppButtonLink({
  appearance = "secondary",
  size = "default",
  className,
  isPending = false,
  children,
  onClick,
  ...props
}: AppButtonLinkProps) {
  return (
    <Link
      {...props}
      data-pending={isPending || undefined}
      aria-busy={isPending || undefined}
      aria-disabled={isPending || undefined}
      onClick={(event) => {
        if (isPending) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
      }}
      className={cn(buttonClasses(appearance, size), pendingButtonClasses, className)}
    >
      {children}
      {isPending && (
        <AppPendingIndicator
          className={
            appearance === "primary"
              ? "text-primary-foreground"
              : appearance === "danger"
                ? "text-white"
                : "text-ink-secondary"
          }
        />
      )}
    </Link>
  );
}
