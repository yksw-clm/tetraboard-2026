import { legalAcknowledgement } from "@tetraboard/protocol/privacy";
export function LegalNotice({ id }: { id?: string }) {
  return (
    <p id={id} className="text-xs leading-relaxed text-muted">
      {legalAcknowledgement}
    </p>
  );
}
