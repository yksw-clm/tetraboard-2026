import { Modal, cn } from "@heroui/react";
import { type ReactNode } from "react";
import { AppIcon } from "./AppIcon";
import { appThemeClasses, type AppTheme } from "./appTheme";

export type AppDialogProps = {
  title: string;
  busy?: boolean;
  onClose: () => void;
  children: ReactNode;
  size?: "default" | "compact";
  theme?: AppTheme;
};

export function AppDialog({
  title,
  busy = false,
  onClose,
  children,
  size = "default",
  theme = "default",
}: AppDialogProps) {
  return (
    <Modal.Backdrop
      className={cn(
        "app-modal app-theme min-h-full h-lvh items-start bg-modal-backdrop bg-none text-ink backdrop-blur-none",
        appThemeClasses[theme],
      )}
      isOpen
      isDismissable={!busy}
      isKeyboardDismissDisabled={busy}
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <Modal.Container
        placement="center"
        size={size === "compact" ? "md" : "lg"}
        className="h-[var(--visual-viewport-height,100dvh)] p-4"
      >
        <Modal.Dialog
          aria-busy={busy}
          className={cn(
            "relative box-border min-h-0 w-full max-h-[calc(var(--visual-viewport-height,100dvh)-32px)] overflow-y-auto overscroll-contain rounded-dialog border border-solid border-line bg-white p-7 text-ink shadow-dialog [@media(max-width:650px)]:px-5 [@media(max-width:650px)]:py-6",
            size === "compact" ? "max-w-[480px]" : "max-w-[500px]",
          )}
        >
          <Modal.Header className="mb-3 flex min-h-8 shrink-0 flex-row items-center justify-between gap-3 pr-11">
            <Modal.Heading className="m-0 text-[22px] leading-normal [@media(max-width:650px)]:text-xl">
              {title}
            </Modal.Heading>
            <Modal.CloseTrigger
              className="absolute top-3 right-3 grid size-11 min-h-11 min-w-11 place-items-center rounded-control border-0 bg-surface-muted p-0 text-muted enabled:hover:bg-surface-hover focus-visible:outline-[3px] focus-visible:outline-focus focus-visible:outline-offset-2 disabled:cursor-default disabled:opacity-50"
              aria-label="閉じる"
              isDisabled={busy}
            >
              <AppIcon name="close" />
            </Modal.CloseTrigger>
          </Modal.Header>
          <Modal.Body className="shrink-0">{children}</Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
