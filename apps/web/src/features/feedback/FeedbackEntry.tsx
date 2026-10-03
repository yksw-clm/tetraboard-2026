import { useState } from "react";
import { AppButton } from "../../shared/ui/AppButton";
import { AppDialog } from "../../shared/ui/AppDialog";
import { FeedbackForm } from "./FeedbackForm";
import { useFeedback, type FeedbackContext } from "./useFeedback";
import { useAccount } from "../account/useAccount";
import type { AppTheme } from "../../shared/ui/appTheme";
export function FeedbackEntry({
  context,
  theme = "default",
}: {
  context: FeedbackContext;
  theme?: AppTheme;
}) {
  const [open, setOpen] = useState(false);
  const account = useAccount();
  const feedback = useFeedback(context, Boolean(account.user));
  return (
    <>
      <AppButton appearance="quiet" size="compact" onPress={() => setOpen(true)}>
        不具合・ご意見
      </AppButton>
      {open && (
        <AppDialog
          title="不具合・ご意見"
          onClose={() => {
            if (!feedback.busy) setOpen(false);
          }}
          busy={feedback.busy}
          theme={theme}
        >
          <FeedbackForm feedback={feedback} context={context} />
        </AppDialog>
      )}
    </>
  );
}
