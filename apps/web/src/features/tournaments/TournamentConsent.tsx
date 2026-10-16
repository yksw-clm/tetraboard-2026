import { publicRecordNotice } from "@tetraboard/protocol/privacy";
import { LegalNotice } from "../privacy/LegalNotice";
import { PrivacyLinks } from "../privacy/PrivacyLinks";

export function TournamentConsent() {
  return (
    <div
      role="note"
      aria-label="大会参加の確認事項"
      className="space-y-1 text-left text-xs leading-relaxed text-muted"
    >
      <p>{publicRecordNotice}</p>
      <LegalNotice />
      <PrivacyLinks newTab />
    </div>
  );
}
