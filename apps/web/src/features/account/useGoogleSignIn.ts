import { useRef, useState } from "react";
import { accountRequest } from "./accountApi";
import {
  clearRegistrationReturn,
  saveRegistrationReturn,
  type RegistrationDestination,
} from "./registrationReturn";

export function useGoogleSignIn() {
  const submitting = useRef(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  async function start(destination?: RegistrationDestination) {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setMessage(null);
    if (destination) saveRegistrationReturn(destination, true);
    else clearRegistrationReturn();
    try {
      const result = (await accountRequest("/api/auth/sign-in/social", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      })) as { url?: string } | null;
      if (!result?.url || new URL(result.url).origin !== "https://accounts.google.com")
        throw new Error("Googleログインを開始できませんでした。");
      window.location.assign(result.url);
    } catch (err) {
      if (destination) saveRegistrationReturn(destination, false);
      else clearRegistrationReturn();
      setMessage(err instanceof Error ? err.message : "Googleログインを開始できませんでした。");
      submitting.current = false;
      setBusy(false);
    }
  }
  return { busy, message, start };
}
