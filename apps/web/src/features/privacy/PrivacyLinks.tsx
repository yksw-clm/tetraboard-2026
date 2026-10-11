export function PrivacyLinks() {
  return (
    <nav aria-label="規約とプライバシー" className="flex flex-wrap justify-center gap-4 text-sm">
      <a href="/terms" className="text-brand underline">
        利用規約
      </a>
      <a href="/privacy" className="text-brand underline">
        プライバシーポリシー
      </a>
    </nav>
  );
}
