import { useEffect, useState, type ReactNode } from "react";
import { Navigate } from "react-router";
import { readGuestRegistration } from "./guestRegistration";
import { GuestRegistrationCompletion } from "./GuestRegistrationCompletion";
import {
  clearRegistrationReturn,
  readRegistrationReturn,
  parseRegistrationReturn,
} from "./registrationReturn";

export function RegistrationCompletion({
  children,
  enabled,
}: {
  children: ReactNode;
  enabled: boolean;
}) {
  const [destination] = useState(readRegistrationReturn);
  const [handoff] = useState(readGuestRegistration);
  useEffect(() => {
    if (enabled && !handoff) clearRegistrationReturn();
  }, [enabled, handoff]);
  if (handoff)
    return <GuestRegistrationCompletion flow={handoff}>{children}</GuestRegistrationCompletion>;
  const validDestination = parseRegistrationReturn(destination);
  return enabled && validDestination?.oauthStarted ? (
    <Navigate to={validDestination.path} state={{ registrationReturn: validDestination }} replace />
  ) : (
    children
  );
}
