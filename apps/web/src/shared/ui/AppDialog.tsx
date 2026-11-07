import { Modal, cn } from "@heroui/react";
import { useLayoutEffect, useRef, type ReactNode, type Ref } from "react";
import { AppIcon } from "./AppIcon";
import { appThemeClasses, type AppTheme } from "./appTheme";

export type AppDialogProps = {
  title: string;
  busy?: boolean;
  dismissible?: boolean;
  onClose: () => void;
  children: ReactNode;
  size?: "default" | "compact";
  compactHeader?: boolean;
  theme?: AppTheme;
  scrollBody?: boolean;
  bodyRef?: Ref<HTMLDivElement>;
  footer?: ReactNode;
};

export function AppDialog({
  title,
  busy = false,
  dismissible = true,
  onClose,
  children,
  size = "default",
  compactHeader = false,
  theme = "default",
  scrollBody = false,
  bodyRef,
  footer,
}: AppDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const focusedRef = useRef<HTMLElement | null>(null);
  const wasBusy = useRef(busy);
  useLayoutEffect(() => {
    const finished = wasBusy.current && !busy;
    wasBusy.current = busy;
    const dialog = dialogRef.current?.querySelector<HTMLElement>('[role="dialog"]');
    if (!finished || !dialog || document.activeElement !== document.body) return;
    // 送信中のdisabled化で失われたフォーカスを戻し、失敗後もEscapeやTabを使えるようにします。
    const previous = focusedRef.current;
    if (previous?.isConnected && dialog.contains(previous) && !previous.matches(":disabled"))
      previous.focus({ preventScroll: true });
    else dialog.focus({ preventScroll: true });
  }, [busy]);
  return (
    <Modal.Backdrop
      className={cn(
        "app-modal app-theme min-h-full h-lvh items-start bg-modal-backdrop bg-none text-ink backdrop-blur-none",
        appThemeClasses[theme],
      )}
      isOpen
      isDismissable={dismissible && !busy}
      isKeyboardDismissDisabled={!dismissible || busy}
      onOpenChange={(open) => {
        if (!open && dismissible && !busy) onClose();
      }}
    >
      <Modal.Container
        placement="center"
        size={size === "compact" ? "md" : "lg"}
        className="h-[var(--visual-viewport-height,100dvh)] p-4"
      >
        <div
          ref={dialogRef}
          className="contents"
          onFocusCapture={(event) => {
            if (event.target instanceof HTMLElement) focusedRef.current = event.target;
          }}
        >
          <Modal.Dialog
            aria-busy={busy}
            className={cn(
              "relative box-border min-h-0 w-full max-h-[calc(var(--visual-viewport-height,100dvh)-32px)] overscroll-contain rounded-dialog border border-solid border-line bg-white p-7 text-ink shadow-dialog [@media(max-width:650px)]:px-5 [@media(max-width:650px)]:py-6",
              scrollBody ? "flex flex-col overflow-hidden" : "overflow-y-auto",
              size === "compact" ? "max-w-[480px]" : "max-w-[500px]",
            )}
          >
            <Modal.Header
              className={cn(
                "flex min-h-8 shrink-0 flex-row items-center justify-between gap-3 pr-11",
                compactHeader ? "mb-1" : "mb-3",
              )}
            >
              <Modal.Heading className="m-0 text-[22px] leading-normal [@media(max-width:650px)]:text-xl">
                {title}
              </Modal.Heading>
              {dismissible && (
                <Modal.CloseTrigger
                  className="absolute top-3 right-3 grid size-11 min-h-11 min-w-11 place-items-center rounded-control border-0 bg-surface-muted p-0 text-muted enabled:hover:bg-surface-hover focus-visible:outline-[3px] focus-visible:outline-focus focus-visible:outline-offset-2 disabled:cursor-default disabled:opacity-50"
                  aria-label="閉じる"
                  isDisabled={busy}
                >
                  <AppIcon name="close" />
                </Modal.CloseTrigger>
              )}
            </Modal.Header>
            <Modal.Body
              ref={bodyRef}
              className={cn(
                scrollBody ? "min-h-0 shrink overflow-y-auto overscroll-contain" : "shrink-0",
                compactHeader && "mt-0",
              )}
            >
              {children}
            </Modal.Body>
            {footer && (
              <div className="mt-4 flex shrink-0 border-0 border-t border-solid border-line pt-4">
                {footer}
              </div>
            )}
          </Modal.Dialog>
        </div>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
