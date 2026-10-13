import type { ReactNode } from "react";
import { Link } from "react-router";
import { PrivacyLinks } from "../privacy/PrivacyLinks";

export function LobbyFooter({ children }: { children: ReactNode }) {
  return (
    <footer className="border-t border-solid border-lobby-footer-line pt-[14px] pb-5 text-center text-xs text-muted">
      <div className="mb-3 flex flex-wrap items-center justify-center gap-3">
        {children}
        <Link to="/updates" className="inline-flex min-h-11 items-center text-brand underline">
          お知らせ
        </Link>
      </div>
      <PrivacyLinks />
      <p className="mt-3">© 2026 chaossi · TetraBoard</p>
    </footer>
  );
}
