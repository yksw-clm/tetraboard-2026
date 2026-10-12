export function PrivacyLinks({ newTab = false }: { newTab?: boolean }) {
  const target = newTab ? "_blank" : undefined;
  const rel = newTab ? "noopener noreferrer" : undefined;
  return (
    <nav aria-label="規約とプライバシー" className="flex flex-wrap justify-center gap-4 text-sm">
      <a
        aria-label={newTab ? "利用規約（別タブで開きます）" : undefined}
        target={target}
        rel={rel}
        href="/terms"
        className="text-brand underline"
      >
        利用規約
      </a>
      <a
        aria-label={newTab ? "プライバシーポリシー（別タブで開きます）" : undefined}
        target={target}
        rel={rel}
        href="/privacy"
        className="text-brand underline"
      >
        プライバシーポリシー
      </a>
    </nav>
  );
}
