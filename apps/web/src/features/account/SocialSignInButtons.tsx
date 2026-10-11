import { LegalAcceptance } from "../privacy/LegalAcceptance";
import { useLocalConsent } from "../privacy/consent";
import type { SocialProvider } from "./useSocialSignIn";
import { AppButton } from "../../shared/ui/AppButton";

export function SocialSignInButtons({
  busy,
  pendingProvider = null,
  adminOnly = false,
  showConsent = true,
  onSignIn,
}: {
  busy: boolean;
  pendingProvider?: SocialProvider | null;
  adminOnly?: boolean;
  showConsent?: boolean;
  onSignIn: (provider: SocialProvider) => void;
}) {
  const accepted = useLocalConsent();
  return (
    <div className="@container w-full flex flex-col gap-3">
      {!adminOnly && showConsent && <LegalAcceptance disabled={busy} />}
      <div
        className={`grid gap-2 ${adminOnly ? "grid-cols-1" : "grid-cols-1 @min-[480px]:grid-cols-2"}`}
      >
        <AppButton
          appearance="secondary"
          className="min-h-11 w-full gap-2.5 border-[#747775] bg-white px-3 text-sm font-medium [font-family:Google_Sans,Arial,sans-serif] text-[#1f1f1f]"
          isDisabled={busy || (!adminOnly && !accepted)}
          isPending={pendingProvider === "google"}
          onPress={() => onSignIn("google")}
        >
          <span aria-hidden="true" className="relative size-5 shrink-0 overflow-hidden">
            <img
              src="/assets/auth/google.png"
              alt=""
              draggable={false}
              width={40}
              height={40}
              className="absolute -left-2.5 -top-2.5 size-10 max-w-none"
            />
          </span>
          Googleで続ける
        </AppButton>
        {!adminOnly && (
          <AppButton
            appearance="secondary"
            className="min-h-11 w-full gap-2.5 border-[#747775] bg-white px-3 text-sm font-medium text-[#1f1f1f]"
            isDisabled={busy || (!adminOnly && !accepted)}
            isPending={pendingProvider === "discord"}
            onPress={() => onSignIn("discord")}
          >
            <img
              src="/assets/auth/discord.svg"
              alt=""
              aria-hidden="true"
              draggable={false}
              width={20}
              height={15}
              className="h-[15px] w-5 shrink-0"
            />
            Discordで続ける
          </AppButton>
        )}
      </div>
    </div>
  );
}
