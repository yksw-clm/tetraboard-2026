import { legalAcknowledgement } from "@tetraboard/protocol/privacy";
export function LegalNotice() {
  return <p className="text-xs leading-relaxed text-muted">{legalAcknowledgement}</p>;
}
