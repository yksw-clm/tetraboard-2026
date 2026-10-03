import { useEffect, useState, type ReactNode } from "react";
import { Navigate } from "react-router";
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
  useEffect(() => {
    if (enabled) clearRegistrationReturn();
  }, [enabled]);
  const validDestination = parseRegistrationReturn(destination);
  return enabled && validDestination?.oauthStarted ? (
    <Navigate to={validDestination.path} state={{ registrationReturn: validDestination }} replace />
  ) : (
    children
  );
}
