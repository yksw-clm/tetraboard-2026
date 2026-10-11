import { legalVersion } from "@tetraboard/protocol/privacy";
import { hasLocalConsent } from "../privacy/consent";
import { useRef, useState } from "react";
import { accountRequest } from "./accountApi";
import {
  clearRegistrationReturn,
  saveRegistrationReturn,
  type RegistrationDestination,
} from "./registrationReturn";

export type SocialProvider = "google" | "discord";

export function useSocialSignIn() {
  const submitting = useRef(false);
  const [busy, setBusy] = useState(false);
  const [pendingProvider, setPendingProvider] = useState<SocialProvider | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  async function start(provider: SocialProvider, destination?: RegistrationDestination | "admin") {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setPendingProvider(provider);
    setMessage(null);
    const registrationDestination = typeof destination === "object" ? destination : undefined;
    if (registrationDestination) saveRegistrationReturn(registrationDestination, true);
    else clearRegistrationReturn();
    try {
      const result = (await accountRequest("/api/auth/sign-in/social", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Legal-Consent": hasLocalConsent() ? legalVersion : "",
        },
        body: JSON.stringify({
          provider,
          ...(destination === "admin" ? { destination: "admin" } : {}),
        }),
      })) as { url?: string } | null;
      if (
        !result?.url ||
        new URL(result.url).origin !==
          (provider === "google" ? "https://accounts.google.com" : "https://discord.com")
      )
        throw new Error(
          `${provider === "google" ? "Google" : "Discord"}ログインを開始できませんでした。`,
        );
      window.location.assign(result.url);
    } catch (err) {
      if (registrationDestination) saveRegistrationReturn(registrationDestination, false);
      else clearRegistrationReturn();
      setMessage(
        err instanceof Error
          ? err.message
          : `${provider === "google" ? "Google" : "Discord"}ログインを開始できませんでした。`,
      );
      submitting.current = false;
      setBusy(false);
      setPendingProvider(null);
    }
  }
  return { busy, pendingProvider, message, start };
}
