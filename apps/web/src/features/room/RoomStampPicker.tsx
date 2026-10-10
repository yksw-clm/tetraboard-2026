import { Popover } from "@heroui/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { roomStampIds, roomStamps, type RoomStampId } from "@tetraboard/protocol";
import { AppButton } from "../../shared/ui/AppButton";
import { appThemeClasses, type AppTheme } from "../../shared/ui/appTheme";

export function RoomStampPicker({
  disabled,
  pending,
  closeSignal,
  onSend,
  theme,
}: {
  disabled: boolean;
  pending: boolean;
  closeSignal: string;
  onSend: (stampId: RoomStampId) => boolean;
  theme: AppTheme;
}) {
  const [openSignal, setOpenSignal] = useState<string | null>(null);
  const open = !disabled && openSignal === closeSignal;
  if (openSignal !== null && (disabled || openSignal !== closeSignal)) setOpenSignal(null);
  const setOpen = useCallback(
    (value: boolean) => setOpenSignal(value ? closeSignal : null),
    [closeSignal],
  );
  const anchor = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const focusOutside = (event: FocusEvent) => {
      if (
        !(event.target instanceof Node) ||
        panel.current?.contains(event.target) ||
        anchor.current?.contains(event.target)
      )
        return;
      setOpen(false);
    };
    const pressOutside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !panel.current?.contains(event.target) &&
        !anchor.current?.contains(event.target)
      )
        setOpen(false);
    };
    document.addEventListener("focusin", focusOutside);
    document.addEventListener("pointerdown", pressOutside);
    return () => {
      document.removeEventListener("focusin", focusOutside);
      document.removeEventListener("pointerdown", pressOutside);
    };
  }, [open, setOpen]);
  return (
    <Popover isOpen={open} onOpenChange={setOpen}>
      <AppButton
        ref={anchor}
        type="button"
        size="compact"
        appearance="secondary"
        isIconOnly
        className="ml-auto size-[38px] min-w-[38px] max-w-[38px] flex-none! p-0 text-xl"
        aria-label="スタンプを送る"
        aria-expanded={open}
        isDisabled={disabled}
        isPending={pending}
      >
        <span aria-hidden="true">🙂</span>
      </AppButton>
      <Popover.Content
        ref={panel}
        triggerRef={anchor}
        placement="top end"
        isNonModal
        shouldCloseOnInteractOutside={(element) => !anchor.current?.contains(element)}
        offset={6}
        containerPadding={8}
        className={`app-theme ${appThemeClasses[theme]} z-50 box-border w-max max-w-[calc(100vw-16px)] rounded-panel border border-line bg-white p-1 text-ink shadow-dialog outline-none`}
      >
        <Popover.Dialog aria-label="スタンプを選択" className="p-0 outline-none">
          <div className="grid grid-cols-[repeat(3,40px)] gap-1">
            {roomStampIds.map((id) => (
              <AppButton
                key={id}
                data-stamp-id={id}
                appearance="quiet"
                size="compact"
                className="size-10 min-w-0 p-0"
                aria-label={roomStamps[id].name}
                onPress={() => {
                  onSend(id);
                  setOpen(false);
                  requestAnimationFrame(() => {
                    if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
                    if (anchor.current?.disabled)
                      anchor.current.closest<HTMLElement>("main")?.focus({ preventScroll: true });
                    else anchor.current?.focus({ preventScroll: true });
                  });
                }}
              >
                <span className="text-2xl leading-none" aria-hidden="true">
                  {roomStamps[id].emoji}
                </span>
              </AppButton>
            ))}
          </div>
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  );
}
