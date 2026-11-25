import { useState } from "react";
import { AppButton } from "../../shared/ui/AppButton";

export function InviteAfterCpuButton({
  leaving,
  registrationBusy,
  socketError,
  onInvite,
}: {
  leaving: boolean;
  registrationBusy: boolean;
  socketError: string | null;
  onInvite: () => void;
}) {
  const [attempted, setAttempted] = useState(false);
  return (
    <>
      <AppButton
        className="mt-4 w-full"
        isDisabled={leaving || registrationBusy}
        isPending={leaving}
        onPress={() => {
          setAttempted(true);
          onInvite();
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
