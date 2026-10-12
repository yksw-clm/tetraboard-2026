import { legalDocuments, legalVersion } from "@tetraboard/protocol/privacy";
import { AccountPageShell } from "../account/AccountPages";
import { AppCard } from "../../shared/ui/AppCard";
export function LegalPage({ kind }: { kind: keyof typeof legalDocuments }) {
  const doc = legalDocuments[kind];
  return (
    <AccountPageShell>
      <AppCard>
        <h1 className="text-2xl font-bold">{doc.title}</h1>
        <p>運営：chaossi　改定日・文書版：{legalVersion}</p>
        {doc.sections.map(([title, body]) => (
          <section key={title} className="flex flex-col gap-2">
            <h2 className="text-lg font-bold">{title}</h2>
            <p className="whitespace-pre-wrap leading-relaxed">{body}</p>
          </section>
        ))}
        <a href="mailto:support@tetraboard.net" className="text-brand underline">
          support@tetraboard.net
        </a>
      </AppCard>
    </AccountPageShell>
  );
}
