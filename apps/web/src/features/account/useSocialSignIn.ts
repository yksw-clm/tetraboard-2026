import { registrationContext, sendRegistrationEntry } from "./registrationAnalytics";
import type { RegistrationAnalyticsInput, RegistrationEntry } from "@tetraboard/protocol";
import type { GameId } from "@tetraboard/protocol/games";
import { legalVersion } from "@tetraboard/protocol/privacy";
import { useCallback, useEffect, useRef, useState } from "react";
import { accountRequest } from "./accountApi";
import type { RegistrationCredential } from "@tetraboard/protocol";
import {
  clearRegistrationReturn,
  saveRegistrationReturn,
  type RegistrationDestination,
} from "./registrationReturn";

export type SocialProvider = "google" | "discord";

export function useSocialSignIn(
  entry: RegistrationEntry = "login-page",
  game: GameId | null = null,
  observeEntry = false,
) {
  const analytics = useRef<RegistrationAnalyticsInput | null>(null);
  const observed = useRef<string | null>(null);
  const context = useCallback(() => {
    if (
      !analytics.current ||
      (entry !== "login-page" &&
        (analytics.current.entry !== entry || analytics.current.game !== game))
    )
      analytics.current = registrationContext(entry, game);
    return analytics.current;
  }, [entry, game]);
  const trackEntry = useCallback(() => {
    const key = `${entry}:${game}`;
    if (observed.current === key) return;
    observed.current = key;
    sendRegistrationEntry(context());
  }, [context, entry, game]);
  useEffect(() => {
    if (observeEntry) trackEntry();
  }, [observeEntry, trackEntry]);
  const submitting = useRef(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const [busy, setBusy] = useState(false);
  const [pendingProvider, setPendingProvider] = useState<SocialProvider | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  async function start(
    provider: SocialProvider,
    destination?: RegistrationDestination | "admin",
    registration?: RegistrationCredential,
  ): Promise<boolean> {
    if (submitting.current) return false;
    submitting.current = true;
    setBusy(true);
    setPendingProvider(provider);
    setMessage(null);
    const request = new AbortController();
    controller.current = request;
    const registrationDestination = typeof destination === "object" ? destination : undefined;
    if (registrationDestination) saveRegistrationReturn(registrationDestination, true);
    else clearRegistrationReturn();
    try {
      if (destination !== "admin") {
        trackEntry();
        context();
      }
      const result = (await accountRequest("/api/auth/sign-in/social", {
        method: "POST",
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(10000)]),
        headers: {
          "Content-Type": "application/json",
          "X-Legal-Consent": legalVersion,
        },
        body: JSON.stringify({
          provider,
          ...(destination !== "admin" ? { analytics: analytics.current } : {}),
          ...(destination === "admin" ? { destination: "admin" } : {}),
          ...(registration
            ? {
                registration: {
                  registrationId: registration.registrationId,
                  secret: registration.secret,
                },
              }
            : {}),
        }),
      })) as { url?: string } | null;
      if (request.signal.aborted) return false;
      if (
        !result?.url ||
        new URL(result.url).origin !==
          (provider === "google" ? "https://accounts.google.com" : "https://discord.com")
      )
        throw new Error(
          `${provider === "google" ? "Google" : "Discord"}ログインを開始できませんでした。`,
        );
      window.location.assign(result.url);
      return true;
    } catch (err) {
      if (request.signal.aborted) return false;
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
      return false;
    }
  }
  return { busy, pendingProvider, message, start, trackEntry };
}
