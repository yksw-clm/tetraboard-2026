import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { Navigate } from "react-router";
import { AppPageLoading } from "../../shared/ui/AppPageState";
import { readGuestRegistration } from "./guestRegistration";
import {
  clearRegistrationReturn,
  readRegistrationReturn,
  parseRegistrationReturn,
} from "./registrationReturn";

const GuestRegistrationCompletion = lazy(async () => ({
  default: (await import("./GuestRegistrationCompletion")).GuestRegistrationCompletion,
}));

export function RegistrationCompletion({
  children,
  enabled,
  guestMergePending = false,
}: {
  children: ReactNode;
  enabled: boolean;
  guestMergePending?: boolean;
}) {
  const [destination] = useState(readRegistrationReturn);
  const [handoff] = useState(readGuestRegistration);
  useEffect(() => {
    if (enabled && !handoff) clearRegistrationReturn();
  }, [enabled, handoff]);
  if (handoff?.linkGuest && guestMergePending) return children;
  if (handoff)
    return (
      <Suspense fallback={<AppPageLoading message="登録の状態を確認しています…" />}>
        <GuestRegistrationCompletion flow={handoff}>{children}</GuestRegistrationCompletion>
      </Suspense>
    );
  const validDestination = parseRegistrationReturn(destination);
  return enabled && validDestination?.oauthStarted ? (
    <Navigate to={validDestination.path} state={{ registrationReturn: validDestination }} replace />
  ) : (
    children
  );
}
