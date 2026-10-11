import { legalAcknowledgement } from "@tetraboard/protocol/privacy";
import { useLocalConsent, rememberConsent, forgetConsent } from "./consent";
import { PrivacyLinks } from "./PrivacyLinks";
export function LegalAcceptance({ disabled = false }: { disabled?: boolean }) {
  const accepted = useLocalConsent();
  return (
    <div className="flex flex-col gap-3 text-sm">
      <PrivacyLinks />
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={accepted}
          disabled={disabled}
          onChange={(e) => {
            const value = e.target.checked;

            if (value) rememberConsent();
            else forgetConsent();
          }}
        />
        {legalAcknowledgement}
      </label>
    </div>
  );
}
