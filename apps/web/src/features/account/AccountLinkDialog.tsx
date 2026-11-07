import { useEffect, useRef, useState } from "react";
import { AppDialog } from "../../shared/ui/AppDialog";
import { AppButton } from "../../shared/ui/AppButton";
import type { AppTheme } from "../../shared/ui/appTheme";
import type { RegistrationDestination } from "./registrationReturn";
import { SocialSignInButtons } from "./SocialSignInButtons";
import { useSocialSignIn, type SocialProvider } from "./useSocialSignIn";

export function AccountLinkDialog({
  feature,
  theme = "default",
  destination,
  beforeSignIn,
  beforeSignInNotice,
  cancelLabel = "あとで",
  onClose,
  onBusyChange,
}: {
  feature?: string;
  theme?: AppTheme;
  destination?: RegistrationDestination;
  beforeSignIn?: () => Promise<void>;
  beforeSignInNotice?: string;
  cancelLabel?: string;
  onClose: () => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const signIn = useSocialSignIn();
  const [preparing, setPreparing] = useState(false);
  const [provider, setProvider] = useState<SocialProvider | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const requestVersion = useRef(0);
  const submitting = useRef(false);
  const busy = preparing || signIn.busy;
  useEffect(
    () => () => {
      requestVersion.current++;
    },
    [],
  );
  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);
  async function start(nextProvider: SocialProvider) {
    if (busy || submitting.current) return;
    submitting.current = true;
    const version = ++requestVersion.current;
    setPreparing(true);
    setProvider(nextProvider);
    setMessage(null);
    try {
      await beforeSignIn?.();
      if (version !== requestVersion.current) return;
      await signIn.start(nextProvider, destination);
    } catch (error) {
      if (version === requestVersion.current)
        setMessage(error instanceof Error ? error.message : "連携の準備ができませんでした。");
    } finally {
      if (version === requestVersion.current) {
        submitting.current = false;
        setPreparing(false);
        setProvider(null);
      }
    }
  }
  return (
    <AppDialog
      title="アカウントを連携しよう"
      size="compact"
      theme={theme}
      busy={busy}
      onClose={onClose}
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm leading-relaxed">
          {feature
            ? `${feature}は、GoogleまたはDiscordと連携すると利用できます。`
            : "連携すると、別の端末でも同じアカウントで遊べます。"}
        </p>
        <p className="text-sm text-muted">ゲストで遊んだ記録を引き継げます。</p>
        {beforeSignInNotice && <p className="text-sm font-semibold">{beforeSignInNotice}</p>}
        <SocialSignInButtons
          busy={busy}
          pendingProvider={provider ?? signIn.pendingProvider}
          consentBelowButtons
          onSignIn={(next) => void start(next)}
        />
        {(message || signIn.message) && (
          <p role="alert" className="text-sm text-danger">
            {message || signIn.message}
          </p>
        )}
        <AppButton type="button" appearance="quiet" isDisabled={busy} onPress={onClose}>
          {cancelLabel}
        </AppButton>
      </div>
    </AppDialog>
  );
}
