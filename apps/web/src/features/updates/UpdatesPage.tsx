import { Link } from "react-router";
import { AppHeader } from "../../shared/ui/AppHeader";
import { appPageWidthClasses } from "../../shared/ui/pageLayout";
import { AccountMenu } from "../account/AccountMenu";
import { sortedUpdates, updateKindLabels, updateGameLabels } from "./updates";
export function UpdatesPage() {
  return (
    <div className="app-theme min-h-dvh bg-page text-ink">
      <AppHeader homeTo="/" homeLabel="ロビーへ">
        <AccountMenu />
      </AppHeader>
      <main className={`${appPageWidthClasses} py-8`}>
        <h1 className="mb-3 text-2xl font-bold">改善のお知らせ</h1>
        <p className="mb-6 text-sm text-muted">公開した修正や、新しい機能をお伝えします。</p>
        <div className="space-y-4">
          {sortedUpdates().map((entry) => (
            <article
              key={entry.id}
              className="rounded-panel border border-line bg-white p-5 sm:p-7"
            >
              <p className="mb-3 text-xs text-muted">
                <time dateTime={entry.date}>{entry.date}</time> ／ {updateKindLabels[entry.kind]} ／{" "}
                {updateGameLabels[entry.game]}
              </p>
              <h2 className="mb-3 text-lg font-bold">{entry.title}</h2>
              <p className="whitespace-pre-wrap text-sm leading-relaxed">{entry.body}</p>
            </article>
          ))}
        </div>
        <p className="mt-6 flex flex-wrap gap-5 text-sm">
          <Link to="/feedback" className="text-brand underline">
            不具合・ご意見
          </Link>
          <Link to="/" className="text-brand underline">
            ロビーへ戻る
          </Link>
        </p>
      </main>
    </div>
  );
}
