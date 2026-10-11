import { Popover, Button, cn } from "@heroui/react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  useState,
  type ReactNode,
} from "react";
import type { PlayerProfile, PlayerProfileTarget, RoomMode } from "@tetraboard/protocol";
import type { GameId } from "@tetraboard/protocol/games";
import { appThemeClasses, type AppTheme } from "../../shared/ui/appTheme";
import { AppButton } from "../../shared/ui/AppButton";
import { AppIcon } from "../../shared/ui/AppIcon";
import { usePlayerProfiles } from "./usePlayerProfiles";
import { emptyProfileState, profileKey } from "./playerProfileStore";
import { PlayerProfileCard } from "./PlayerProfileCard";
const idleSubscribe = () => () => {};
export function PlayerProfileTrigger({
  target,
  localProfile,
  game,
  mode,
  theme = "default",
  label,
  className,
  children,
}: {
  target?: PlayerProfileTarget | null;
  localProfile?: PlayerProfile;
  game: GameId;
  mode: RoomMode;
  theme?: AppTheme;
  label: string;
  className?: string;
  children: ReactNode;
}) {
  const context = usePlayerProfiles();
  const closePreview = context?.close;
  const store = context?.store;
  const dismissVersion = context?.dismissVersion ?? 0;
  const [portalContainer, setPortalContainer] = useState<HTMLElement | undefined>(undefined);
  const id = useId();
  const anchor = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLElement>(null);
  const flags = useRef({
    hovered: false,
    focused: false,
    cardHovered: false,
    cardFocused: false,
    suppressed: false,
  });
  const timers = useRef<{
    open?: ReturnType<typeof setTimeout>;
    close?: ReturnType<typeof setTimeout>;
  }>({});
  const key = target ? profileKey(target, game) : "";
  const state = useSyncExternalStore(
    context?.store.subscribe ?? idleSubscribe,
    () => context?.store.get(key) ?? emptyProfileState,
    () => emptyProfileState,
  );
  const active = context?.active?.id === id;
  const pinned = active && context?.active?.pinned;
  const anyPinned = context?.active?.pinned;
  const clearTimers = useCallback(() => {
    clearTimeout(timers.current.open);
    clearTimeout(timers.current.close);
  }, []);
  const close = useCallback(
    (restore = false, suppress = false) => {
      clearTimers();
      flags.current.suppressed = suppress;
      flags.current.cardHovered = false;
      flags.current.cardFocused = false;
      closePreview?.(id, suppress);
      if (restore) anchor.current?.focus({ preventScroll: true });
    },
    [closePreview, id, clearTimers],
  );
  const open = (pin: boolean) => {
    clearTimers();
    if (!pin && (flags.current.suppressed || anyPinned)) return;
    setPortalContainer(anchor.current?.closest<HTMLElement>('[role="dialog"]') ?? undefined);
    context?.activate(id, pin);
    if (target && !localProfile) void context?.store.load(target, game);
  };
  useEffect(() => {
    if (active && target === null && !localProfile) close();
  }, [active, target, localProfile, close]);
  useEffect(() => {
    if (anyPinned) clearTimers();
  }, [anyPinned, clearTimers]);
  useEffect(() => {
    if (!dismissVersion) return;
    clearTimers();
    if (flags.current.hovered || flags.current.focused) flags.current.suppressed = true;
  }, [dismissVersion, clearTimers]);
  const leave = () => {
    const f = flags.current;
    clearTimeout(timers.current.open);
    if (!pinned && !f.hovered && !f.focused && !f.cardHovered && !f.cardFocused)
      timers.current.close = setTimeout(() => close(), 150);
  };
  useEffect(() => {
    if (active && target && !localProfile && !state.loading && !state.profile && !state.error)
      void store?.load(target, game);
  }, [active, target, localProfile, state, store, game]);
  const attachCard = useCallback(
    (element: HTMLElement | null) => {
      card.current = element;
      if (pinned) element?.focus({ preventScroll: true });
    },
    [pinned],
  );
  useLayoutEffect(() => {
    if (pinned) card.current?.focus({ preventScroll: true });
  }, [pinned]);
  useEffect(() => {
    if (!active) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      close(Boolean(pinned), true);
    };
    const outside = (event: Event) => {
      if (
        event.target instanceof Node &&
        !anchor.current?.contains(event.target) &&
        !card.current?.contains(event.target)
      )
        close(false, true);
    };
    const scroll = (event: Event) => {
      if (!(event.target instanceof Node) || !card.current?.contains(event.target))
        close(false, true);
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("click", outside, true);
    document.addEventListener("keydown", escape, true);
    document.addEventListener("scroll", scroll, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("click", outside, true);
      document.removeEventListener("keydown", escape, true);
      document.removeEventListener("scroll", scroll, true);
    };
  }, [active, pinned, close]);
  useEffect(
    () => () => {
      clearTimers();
      closePreview?.(id);
    },
    [clearTimers, closePreview, id, key, game, mode],
  );
  if (!context || target === null) return <span className={className}>{children}</span>;
  return (
    <Popover
      isOpen={active}
      onOpenChange={(isOpen) => {
        if (!isOpen) close(false, true);
      }}
    >
      <Button
        type="button"
        ref={anchor}
        className={cn(
          "m-0 h-auto min-h-0 min-w-0 rounded-none border-0 bg-transparent p-0 text-inherit font-inherit text-left cursor-pointer focus-visible:outline-[3px] focus-visible:outline-focus focus-visible:outline-offset-2",
          className,
        )}
        aria-label={`${label}のプレイヤー情報`}
        aria-expanded={active}
        aria-controls={active ? `${id}-card` : undefined}
        onPointerEnter={(event) => {
          if (event.pointerType === "touch") return;
          if (!flags.current.hovered && !flags.current.focused) flags.current.suppressed = false;
          flags.current.hovered = true;
          clearTimeout(timers.current.close);
          if (!flags.current.suppressed) timers.current.open = setTimeout(() => open(false), 300);
        }}
        onPointerLeave={() => {
          flags.current.hovered = false;
          leave();
        }}
        onFocus={() => {
          flags.current.focused = true;
          open(false);
        }}
        onBlur={(event) => {
          flags.current.focused = false;
          if (
            !flags.current.hovered &&
            event.relatedTarget instanceof HTMLElement &&
            event.relatedTarget !== document.body &&
            !card.current?.contains(event.relatedTarget)
          )
            flags.current.suppressed = false;
          leave();
        }}
        onClick={() => open(true)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            open(true);
          } else event.continuePropagation();
        }}
      >
        {children}
      </Button>
      <Popover.Content
        isNonModal
        triggerRef={anchor}
        placement="bottom"
        offset={6}
        containerPadding={16}
        UNSTABLE_portalContainer={portalContainer}
        className={cn(
          "app-theme z-50 box-border flex flex-col w-[280px] max-w-[calc(100vw-32px)] rounded-panel border border-line bg-white p-4 text-ink shadow-dialog outline-none",
          appThemeClasses[theme],
        )}
      >
        <section
          id={`${id}-card`}
          ref={attachCard}
          role="region"
          aria-label={`${label}のプレイヤー情報`}
          tabIndex={-1}
          className="relative min-h-0 overflow-x-hidden overflow-y-auto overscroll-contain outline-none"
          onPointerEnter={() => {
            flags.current.cardHovered = true;
            clearTimeout(timers.current.close);
          }}
          onPointerLeave={() => {
            flags.current.cardHovered = false;
            leave();
          }}
          onFocusCapture={() => {
            flags.current.cardFocused = true;
            clearTimeout(timers.current.close);
          }}
          onBlurCapture={(event) => {
            flags.current.cardFocused =
              event.relatedTarget instanceof Node &&
              event.currentTarget.contains(event.relatedTarget);
            leave();
          }}
        >
          <div className="absolute right-0 top-0">
            <AppButton
              appearance="quiet"
              size="compact"
              className="size-8 min-h-8 min-w-8 rounded-full p-0"
              aria-label="プレイヤー情報を閉じる"
              onPress={() => close(true, true)}
            >
              <AppIcon name="close" className="size-4" />
            </AppButton>
          </div>
          <PlayerProfileCard
            state={state}
            localProfile={localProfile}
            game={game}
            mode={mode}
            onRetry={() => {
              if (target) void context.store.load(target, game, true);
            }}
          />
        </section>
      </Popover.Content>
    </Popover>
  );
}
