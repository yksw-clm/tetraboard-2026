import { Button as HeroButton, Modal } from "@heroui/react";
import type { ComponentProps, ReactNode } from "react";

export function Button({
  className = "",
  variant = "secondary",
  ...props
}: Omit<ComponentProps<typeof HeroButton>, "variant"> & {
  variant?: "primary" | "secondary" | "quiet";
}) {
  const colors =
    variant === "primary"
      ? "bg-[#345c49] text-white hover:bg-[#274b3a]"
      : variant === "quiet"
        ? "bg-transparent text-[#586657] hover:bg-[#e9eee7]"
        : "border border-[#d7ddd1] bg-white text-[#354333] hover:bg-[#eff3eb]";
  return (
    <HeroButton
      type="button"
      {...props}
      className={`inline-flex min-h-9 items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold transition-colors disabled:opacity-45 ${colors} ${className}`}
    />
  );
}
export function Dialog({
  title,
  children,
  onClose,
  busy = false,
}: {
  title: string;
  children: ReactNode;
  onClose(): void;
  busy?: boolean;
}) {
  return (
    <Modal.Backdrop
      isOpen
      isDismissable={!busy}
      isKeyboardDismissDisabled={busy}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      className="bg-[#22312666] backdrop-blur-[2px]"
    >
      <Modal.Container placement="center" className="p-5">
        <Modal.Dialog
          className="study-theme w-full max-w-[560px] max-h-[90dvh] overflow-y-auto rounded-2xl border border-[#dce2d6] bg-[#fcfdf9] p-6 text-[#293829] shadow-2xl"
          aria-busy={busy}
        >
          <Modal.Header className="mb-5 flex items-center justify-between">
            <Modal.Heading className="text-lg font-bold">{title}</Modal.Heading>
            <Modal.CloseTrigger
              isDisabled={busy}
              aria-label="閉じる"
              className="grid size-8 place-items-center rounded-lg hover:bg-[#e9eee7]"
            >
              ×
            </Modal.CloseTrigger>
          </Modal.Header>
          <Modal.Body>{children}</Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
export const fieldClass =
  "w-full rounded-lg border border-[#d4ddce] bg-white px-3 py-2 text-sm text-[#2d3b2e] focus:outline-2 focus:outline-[#64836a]";
export function Field({
  label,
  children,
  help,
}: {
  label: string;
  children: ReactNode;
  help?: string;
}) {
  return (
    <label className="flex flex-col gap-1.5 text-xs font-semibold text-[#53614f]">
      <span>{label}</span>
      {children}
      {help ? <span className="font-normal leading-relaxed text-[#7c8775]">{help}</span> : null}
    </label>
  );
}
export function Panel({
  title,
  eyebrow,
  children,
  action,
}: {
  title: string;
  eyebrow?: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-[#e0e5da] bg-white p-4 shadow-[0_2px_5px_#31402503]">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div>
          {eyebrow ? (
            <p className="mb-1 text-[9px] font-bold tracking-[0.14em] text-[#8b9683]">{eyebrow}</p>
          ) : null}
          <h2 className="text-sm font-bold">{title}</h2>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
