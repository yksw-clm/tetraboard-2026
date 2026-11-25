import { useId, useState } from "react";
import { legalVersion } from "@tetraboard/protocol/privacy";
import { AppButton } from "../../shared/ui/AppButton";
import { LegalNotice } from "../privacy/LegalNotice";

export function InviteAfterCpuButton({
  leaving,
  registrationBusy,
  socketError,
  onInvite,
}: {
  leaving: boolean;
  registrationBusy: boolean;
  socketError: string | null;
  onInvite: (consentVersion: string) => void;
}) {
  const [attempted, setAttempted] = useState(false);
  const consentId = useId();
  return (
    <>
      <div className="mt-4">
        <LegalNotice id={consentId} />
      </div>
      <AppButton
        className="mt-4 w-full"
        aria-describedby={consentId}
        isDisabled={leaving || registrationBusy}
        isPending={leaving}
        onPress={() => {
          setAttempted(true);
          onInvite(legalVersion);
        }}
      >
        友達と遊ぶ
      </AppButton>
      {attempted && !leaving && socketError && (
        <p className="mt-3 text-sm text-danger" role="alert">
          {socketError}
        </p>
      )}
    </>
  );
}
