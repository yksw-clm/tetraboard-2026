import { type ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import {
  announcementDetailSchema,
  announcementKindLabels,
  announcementListSchema,
} from "@tetraboard/protocol";
import { AppHeader } from "../../shared/ui/AppHeader";
import { AppButton, AppButtonLink } from "../../shared/ui/AppButton";
import { AppCard } from "../../shared/ui/AppCard";
import { appPageWidthClasses } from "../../shared/ui/pageLayout";
import { AccountMenu } from "../account/AccountMenu";
import { useAnnouncementData } from "./useAnnouncementData";
const parseList = (body: unknown) => announcementListSchema.parse(body);
const parseDetail = (body: unknown) => announcementDetailSchema.parse(body);
function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="app-theme min-h-dvh bg-page text-ink">
      <AppHeader homeTo="/" homeLabel="ロビーへ">
        <AccountMenu />
      </AppHeader>
      <main className={`${appPageWidthClasses} py-8 space-y-5 wrap-anywhere`}>
        {children}
        <p className="flex flex-wrap gap-5 text-sm">
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
function Status({
  state,
}: {
  state: { loading: boolean; error: string | null; status?: number; retry: () => void };
}) {
  return (
    <>
      {state.loading && <p role="status">お知らせを読み込んでいます…</p>}
      {state.error && (
        <div className="space-y-3">
          <p role="alert">{state.error}</p>
          {state.status !== 404 && (
            <AppButton onPress={state.retry} isPending={state.loading} isDisabled={state.loading}>
              再試行
            </AppButton>
          )}
        </div>
      )}
    </>
  );
}
export function UpdatesPage() {
  const [search] = useSearchParams();
  const cursor = search.get("cursor");
  const state = useAnnouncementData(
    `/api/announcements${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
    parseList,
  );
  return (
    <Layout>
      <h1 className="text-2xl font-bold">お知らせ</h1>
      <p className="text-sm text-muted">改善や新機能、大会などのお知らせをお届けします。</p>
      <Status state={state} />
      {state.data && (
        <>
          {state.data.announcements.length === 0 && <p>お知らせはまだありません。</p>}
          {state.data.announcements.map((entry) => (
            <AppCard key={entry.id} className="gap-3">
              <p className="text-xs text-muted">
                <time dateTime={entry.date}>{entry.date}</time> ／{" "}
                {announcementKindLabels[entry.kind]}
              </p>
              <h2 className="text-lg font-bold">
                <Link className="text-brand underline" to={`/updates/${entry.id}`}>
                  {entry.title}
                </Link>
              </h2>
              <p className="text-sm leading-relaxed">{entry.summary}</p>
              <Link
                className="inline-flex min-h-11 items-center text-sm text-brand underline"
                to={`/updates/${entry.id}`}
              >
                全文を読む<span className="sr-only">：{entry.title}</span>
              </Link>
            </AppCard>
          ))}
          {state.data.nextCursor && (
            <AppButtonLink to={`/updates?cursor=${encodeURIComponent(state.data.nextCursor)}`}>
              もっと見る
            </AppButtonLink>
          )}
        </>
      )}
      {cursor && (
        <Link className="inline-flex min-h-11 items-center text-brand underline" to="/updates">
          最新のお知らせへ
        </Link>
      )}
    </Layout>
  );
}
export function UpdateDetailPage() {
  const { id } = useParams();
  const state = useAnnouncementData(
    `/api/announcements/${encodeURIComponent(id ?? "")}`,
    parseDetail,
  );
  return (
    <Layout>
      <Status state={state} />
      {state.data && (
        <article className="space-y-4">
          <p className="text-xs text-muted">
            <time dateTime={state.data.date}>{state.data.date}</time> ／{" "}
            {announcementKindLabels[state.data.kind]}
          </p>
          <h1 className="text-2xl font-bold">{state.data.title}</h1>
          <p className="whitespace-pre-wrap text-sm leading-relaxed">{state.data.body}</p>
        </article>
      )}
      <AppButtonLink to="/updates">お知らせ一覧へ</AppButtonLink>
    </Layout>
  );
}
