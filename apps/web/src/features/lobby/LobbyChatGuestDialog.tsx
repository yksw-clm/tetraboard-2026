import { useEffect, useRef, useState } from "react";
import { profileInputSchema } from "@tetraboard/protocol";
import { ensureGuestAccount, guestStorageNotice } from "../account/guestAccount";
import { useAccount } from "../account/useAccount";
import { LegalNotice } from "../privacy/LegalNotice";
import { PrivacyLinks } from "../privacy/PrivacyLinks";
import { readGuestName } from "../../shared/guestName";
import { AppDialog } from "../../shared/ui/AppDialog";
import { AppTextField } from "../../shared/ui/AppTextField";
import { AppButton } from "../../shared/ui/AppButton";

export function LobbyChatGuestDialog({ onClose }: { onClose: () => void }) {
  const account = useAccount();
  const [name, setName] = useState(() => account.user?.name ?? readGuestName());
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState<string | null>(null);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const valid = profileInputSchema.shape.name.safeParse(name).success;
  async function start() {
    if (busy || !valid || account.loading || account.error) return;
    setBusy(true);
    setMessage(null);
    try {
      const user = await ensureGuestAccount(name, account.user);
      if (!active.current) return;
      account.update(user);
      onClose();
    } catch (error) {
      if (active.current)
        setMessage(error instanceof Error ? error.message : "名前を設定できませんでした。");
    } finally {
      if (active.current) setBusy(false);
    }
  }
  return (
    <AppDialog title="公開チャットで使う名前" size="compact" busy={busy} onClose={onClose}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void start();
        }}
      >
        <AppTextField value={name} onChange={setName} isDisabled={busy}>
          <AppTextField.Label>ニックネーム</AppTextField.Label>
          <AppTextField.Input autoFocus autoComplete="nickname" placeholder="例：てとら" />
          <AppTextField.Description>
            1〜10文字。本名・連絡先は入力しないでください。
          </AppTextField.Description>
        </AppTextField>
        <p className="text-xs text-muted">名前と投稿は公開されます。{guestStorageNotice}</p>
        <LegalNotice />
        <PrivacyLinks />
        {(message || account.error) && (
          <p role="alert" className="text-sm text-danger">
            {message ?? account.error}
          </p>
        )}
        {account.error && (
          <AppButton
            appearance="secondary"
            isDisabled={account.loading}
            onPress={() => void account.refresh("chat-identity")}
          >
            再試行
          </AppButton>
        )}
        <AppButton
          type="submit"
          isPending={busy}
          isDisabled={busy || !valid || account.loading || Boolean(account.error)}
        >
          この名前でチャットを始める
        </AppButton>
      </form>
    </AppDialog>
  );
}
