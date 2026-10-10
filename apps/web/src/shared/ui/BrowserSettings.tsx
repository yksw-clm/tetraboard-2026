import { Label, Switch } from "@heroui/react";
import { useRef, useState } from "react";
import { browserSettings } from "../browserSettings";
import { useBrowserSettings } from "../useBrowserSettings";
import { roomSounds } from "../soundEffects";
import { AppButton } from "./AppButton";
import { AppDialog } from "./AppDialog";
import { AppIcon } from "./AppIcon";
import type { AppTheme } from "./appTheme";

export function SettingsStorageNotice() {
  const { storageError } = useBrowserSettings();
  return storageError ? (
    <p role="status" className="mt-2 text-xs text-muted">
      この画面では反映されていますが、次回の読み込み後は保持されない場合があります。
    </p>
  ) : null;
}

export function StampVisibilitySetting({ compact = false }: { compact?: boolean }) {
  const { stampsVisible } = useBrowserSettings();
  return (
    <Switch
      aria-label="カード上のスタンプ表示"
      isSelected={stampsVisible}
      onChange={(stampsVisible) => browserSettings.update({ stampsVisible })}
      className="w-full [--switch-control-bg-checked:var(--color-brand)] [--switch-control-bg-checked-hover:var(--color-brand-hover)]"
    >
      <Switch.Content
        className={`w-full justify-between gap-3 rounded-control ${compact ? "min-h-10 px-2 text-xs" : "min-h-12 text-sm"}`}
      >
        <Label className="text-ink font-[650]">カード上のスタンプ表示</Label>
        <Switch.Control>
          <Switch.Thumb />
        </Switch.Control>
      </Switch.Content>
    </Switch>
  );
}

export function BrowserSettingsButton({
  theme = "default",
  compact = false,
  isOpen,
  onOpenChange,
  disabled = false,
}: {
  theme?: AppTheme;
  compact?: boolean;
  isOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
}) {
  const [localOpen, setLocalOpen] = useState(false);
  const open = isOpen ?? localOpen;
  const anchor = useRef<HTMLButtonElement>(null);
  const { soundEnabled } = useBrowserSettings();
  function setOpen(value: boolean) {
    if (onOpenChange) onOpenChange(value);
    else setLocalOpen(value);
    if (!value) requestAnimationFrame(() => anchor.current?.focus({ preventScroll: true }));
  }
  return (
    <>
      <AppButton
        ref={anchor}
        appearance="quiet"
        size="compact"
        isIconOnly
        isDisabled={disabled}
        aria-label="表示・サウンド設定"
        aria-haspopup="dialog"
        aria-expanded={open}
        onPress={() => setOpen(true)}
        className={compact ? "size-6 min-h-0! min-w-0! p-0! rounded-md" : "size-11 min-w-11 p-0"}
      >
        <AppIcon name="preferences" />
      </AppButton>
      {open && (
        <AppDialog
          title="表示・サウンド設定"
          theme={theme}
          size="compact"
          onClose={() => setOpen(false)}
        >
          <div className="divide-y divide-line">
            <Switch
              aria-label="効果音"
              isSelected={soundEnabled}
              onChange={(soundEnabled) => {
                browserSettings.update({ soundEnabled });
                if (soundEnabled) roomSounds.activate();
              }}
              className="w-full [--switch-control-bg-checked:var(--color-brand)] [--switch-control-bg-checked-hover:var(--color-brand-hover)]"
            >
              <Switch.Content className="w-full min-h-12 justify-between gap-3 rounded-control text-sm">
                <Label className="text-ink font-[650]">効果音</Label>
                <Switch.Control>
                  <Switch.Thumb />
                </Switch.Control>
              </Switch.Content>
            </Switch>
            <StampVisibilitySetting />
          </div>
          <p className="mt-4 text-xs leading-relaxed text-muted">このブラウザで共通の設定です。</p>
          <p className="mt-2 text-xs leading-relaxed text-muted">
            音が出ない場合は、画面を操作し、端末の音量・消音設定を確認してください。
          </p>
          <SettingsStorageNotice />
        </AppDialog>
      )}
    </>
  );
}
