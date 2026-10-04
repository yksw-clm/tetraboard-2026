import { gameCatalog, gameScopeIds } from "@tetraboard/protocol/games";
import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { Button, Card } from "@heroui/react";
import {
  feedbackDetailSchema,
  feedbackListSchema,
  feedbackTopicsSchema,
  feedbackSummarySchema,
  feedbackRecordSchema,
  type FeedbackRecord,
  type FeedbackTopic,
  type FeedbackDetail,
} from "@tetraboard/protocol";
import { useAdminData } from "./useAdminData";
import { adminMutation, AdminApiError } from "./api";
const parseList = (v: unknown) => feedbackListSchema.parse(v);
const parseDetail = (v: unknown) => feedbackDetailSchema.parse(v);
const parseTopics = (v: unknown) => feedbackTopicsSchema.parse(v);
const parseSummary = (v: unknown) => feedbackSummarySchema.parse(v);
const kinds = { bug: "不具合", request: "機能の要望", opinion: "その他のご意見" };
const games = Object.fromEntries(
  gameScopeIds.map((id) => [id, id === "all" ? "サービス全体" : gameCatalog[id].name]),
);
const statuses = {
  new: "未確認",
  reviewing: "確認中",
  planned: "対応予定",
  working: "対応中",
  done: "完了",
  declined: "見送り",
  spam: "迷惑投稿",
};
const priorities = { high: "高", normal: "通常", low: "低" };
const field = "w-full rounded-lg border border-gray-300 bg-white p-3 text-sm disabled:opacity-60";
const date = (ms: number) => new Date(ms).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
const duration = (ms: number | null) =>
  ms === null
    ? "—"
    : ms < 60000
      ? "1分未満"
      : ms < 3600000
        ? `${Math.floor(ms / 60000)}分`
        : `${(ms / 3600000).toFixed(1)}時間`;
function ErrorMessage({ error, status }: { error: string | null; status?: number }) {
  return error ? (
    <div role="alert" className="rounded-lg bg-red-50 p-4 text-sm text-red-800">
      {error}
      {status === 401 && (
        <a className="ml-3 underline" href="/login?destination=admin">
          ログインへ
        </a>
      )}
    </div>
  ) : null;
}
function Options({ values }: { values: Record<string, string> }) {
  return Object.entries(values).map(([v, label]) => (
    <option key={v} value={v}>
      {label}
    </option>
  ));
}

export function Feedback() {
  const [search, setSearch] = useSearchParams();
  const [includeInternal, setIncludeInternal] = useState(false);
  const [topicManager, setTopicManager] = useState(false);
  const list = useAdminData(`/api/admin/feedback?${search}`, parseList);
  const topics = useAdminData("/api/admin/feedback/topics", parseTopics);
  const summary = useAdminData(
    `/api/admin/feedback/summary?includeInternal=${includeInternal}`,
    parseSummary,
  );
  function filter(key: string, value: string) {
    const next = new URLSearchParams(search);
    next.delete("cursor");
    if (value) next.set(key, value);
    else next.delete(key);
    setSearch(next);
  }
  function refresh() {
    list.refresh();
    topics.refresh();
    summary.refresh();
  }
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">フィードバック</h1>
        <Button onPress={refresh} isDisabled={list.loading}>
          更新
        </Button>
      </div>
      <p className="text-sm text-gray-600">
        原則、翌日までに新着を確認します。修正期限は約束せず、完了は本番公開の確認後に記録します。投稿・画像は180日で削除されます。
      </p>
      <ErrorMessage
        error={list.error ?? summary.error ?? topics.error}
        status={list.status ?? summary.status ?? topics.status}
      />
      <label className="flex min-h-11 items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={includeInternal}
          onChange={(e) => setIncludeInternal(e.target.checked)}
        />
        集計に運営・テスト投稿を含める
      </label>
      {summary.data && (
        <>
          <section aria-label="確認速度" className="grid gap-3 sm:grid-cols-3">
            {[
              ["未確認", `${summary.data.unreviewed}件`],
              ["最古の未確認", duration(summary.data.oldestUnreviewedMs)],
              ["初回確認までの中央値", duration(summary.data.medianReviewMs)],
            ].map(([label, value]) => (
              <Card key={label} className="gap-2 p-5">
                <h2 className="text-sm text-gray-600">{label}</h2>
                <p className="text-2xl font-bold">{value}</p>
              </Card>
            ))}
          </section>
          <Card className="gap-3 p-5">
            <h2 className="font-bold">過去180日のテーマ別需要</h2>
            <p className="text-xs text-gray-600">
              報告者数はアカウント・ゲストのブラウザ単位の参考値です。登録前後や端末間では統合しません。迷惑投稿は除外します。
            </p>
            {summary.data.topics.length === 0 ? (
              <p>集計対象の投稿はありません。</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr>
                      <th className="p-2 text-left">テーマ</th>
                      <th className="p-2 text-right">投稿</th>
                      <th className="p-2 text-right">報告者</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.data.topics.map((t) => (
                      <tr key={t.id ?? "none"} className="border-t">
                        <td className="p-2">
                          <button
                            className="min-h-11 text-brand underline text-left"
                            onClick={() => filter("topicId", t.id ?? "none")}
                          >
                            {t.name}
                          </button>
                        </td>
                        <td className="p-2 text-right">{t.posts}</td>
                        <td className="p-2 text-right">{t.reporters}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
      <Card className="gap-4 p-5">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          {(
            [
              ["kind", "種別", kinds],
              ["game", "対象", games],
              ["status", "対応状況", statuses],
              ["priority", "優先度", priorities],
            ] as const
          ).map(([key, label, values]) => (
            <label key={key} className="text-sm">
              {label}
              <select
                className={`${field} mt-1`}
                value={search.get(key) ?? ""}
                onChange={(e) => filter(key, e.target.value)}
              >
                <option value="">すべて</option>
                <Options values={values} />
              </select>
            </label>
          ))}
          <label className="text-sm">
            テーマ
            <select
              className={`${field} mt-1`}
              value={search.get("topicId") ?? ""}
              onChange={(e) => filter("topicId", e.target.value)}
            >
              <option value="">すべて</option>
              <option value="none">未分類</option>
              {topics.data?.topics.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div>
          <Button onPress={() => setTopicManager((old) => !old)}>テーマを管理</Button>
        </div>
        {topicManager && (
          <TopicManager topics={topics.data?.topics ?? []} onSaved={topics.refresh} />
        )}
      </Card>
      {list.loading && <p role="status">読み込んでいます…</p>}
      {list.data && (
        <>
          <p className="text-xs text-gray-600">
            新着順・1ページ50件。内部投稿は一覧には表示され、需要集計からは初期除外されます。
          </p>
          {list.data.feedback.length === 0 ? (
            <p>該当する投稿はありません。</p>
          ) : (
            <div className="space-y-3">
              {list.data.feedback.map((r) => (
                <Card key={r.id} className="gap-2 p-5">
                  <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-gray-600">
                    <span>{date(r.receivedAtMs)}</span>
                    <span>
                      {kinds[r.kind]} ／ {games[r.game]}
                    </span>
                    <span>
                      {statuses[r.status]} ／ 優先度：{priorities[r.priority]}
                    </span>
                    {r.internal && <span>運営・テスト</span>}
                  </div>
                  <Link
                    to={`/feedback/${r.id}`}
                    className="block min-h-11 py-2 text-brand underline whitespace-pre-wrap break-words"
                  >
                    {Array.from(r.body).slice(0, 120).join("")}
                    {Array.from(r.body).length > 120 ? "…" : ""}
                  </Link>
                  <p className="text-xs text-gray-600">
                    {r.author === "account" ? "登録者" : "ゲスト"}
                    {r.hasAttachment ? " ／ 画像あり" : ""}
                  </p>
                </Card>
              ))}
            </div>
          )}
          <div className="flex gap-3">
            {search.has("cursor") && (
              <Button
                onPress={() => {
                  const next = new URLSearchParams(search);
                  next.delete("cursor");
                  setSearch(next);
                }}
              >
                最初のページ
              </Button>
            )}
            {list.data.nextCursor && (
              <Button
                onPress={() => {
                  const next = new URLSearchParams(search);
                  next.set("cursor", list.data!.nextCursor!);
                  setSearch(next);
                }}
              >
                次の50件
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function TopicManager({ topics, onSaved }: { topics: FeedbackTopic[]; onSaved: () => void }) {
  const [selected, setSelected] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [version, setVersion] = useState(1);
  async function save() {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      await adminMutation(
        selected ? `/api/admin/feedback/topics/${selected}` : "/api/admin/feedback/topics",
        selected ? "PATCH" : "POST",
        selected ? { name, version } : { name },
      );
      setSelected("");
      setName("");
      onSaved();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "保存できませんでした。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="grid gap-3 border-t pt-4 sm:grid-cols-2">
      <label className="text-sm">
        編集するテーマ
        <select
          className={`${field} mt-1`}
          value={selected}
          disabled={busy}
          onChange={(e) => {
            const t = topics.find((v) => v.id === e.target.value);
            setSelected(e.target.value);
            setName(t?.name ?? "");
            setVersion(t?.version ?? 1);
          }}
        >
          <option value="">新しく作る</option>
          {topics.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </label>
      <label className="text-sm">
        テーマ名
        <input
          className={`${field} mt-1`}
          value={name}
          disabled={busy}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      {message && (
        <p role="alert" className="text-sm text-red-800 sm:col-span-2">
          {message}
        </p>
      )}
      <div>
        <Button onPress={() => void save()} isDisabled={busy}>
          {busy ? "保存中…" : "テーマを保存"}
        </Button>
      </div>
    </div>
  );
}

export function FeedbackDetailPage() {
  const { id } = useParams();
  const detail = useAdminData(`/api/admin/feedback/${id}`, parseDetail);
  const topics = useAdminData("/api/admin/feedback/topics", parseTopics);
  return (
    <div className="space-y-5">
      <Link className="inline-flex min-h-11 items-center text-brand underline" to="/feedback">
        一覧へ戻る
      </Link>
      <h1 className="text-2xl font-bold">投稿の確認</h1>
      <ErrorMessage error={detail.error ?? topics.error} status={detail.status ?? topics.status} />
      {detail.loading && <p role="status">読み込んでいます…</p>}
      <Button onPress={detail.refresh} isDisabled={detail.loading}>
        再取得
      </Button>
      {detail.data && (
        <FeedbackEditor
          key={`${id}:${detail.data.feedback.version}`}
          detail={detail.data}
          topics={topics.data?.topics ?? []}
          onSaved={detail.refresh}
        />
      )}
    </div>
  );
}
function FeedbackEditor({
  detail,
  topics,
  onSaved,
}: {
  detail: FeedbackDetail;
  topics: FeedbackTopic[];
  onSaved: () => void;
}) {
  const r = detail.feedback;
  const [status, setStatus] = useState(r.status);
  const [priority, setPriority] = useState(r.priority);
  const [topicId, setTopicId] = useState(r.topicId ?? "");
  const [note, setNote] = useState(r.note);
  const [issueUrl, setIssueUrl] = useState(r.issueUrl);
  const [published, setPublished] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [errorStatus, setErrorStatus] = useState<number | undefined>();
  async function save(remove = false) {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    setErrorStatus(undefined);
    try {
      const body = await adminMutation(
        `/api/admin/feedback/${r.id}`,
        remove ? "DELETE" : "PATCH",
        remove
          ? { version: r.version }
          : {
              version: r.version,
              status,
              priority,
              topicId: topicId || null,
              note,
              issueUrl,
              published,
            },
      );
      if (remove) setDeleted(true);
      else {
        feedbackRecordSchema.parse(body);
        onSaved();
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "処理できませんでした。");
      setErrorStatus(err instanceof AdminApiError ? err.status : undefined);
    } finally {
      setBusy(false);
    }
  }
  if (deleted)
    return (
      <Card className="p-5">
        <p role="status">投稿を削除しました。画像は定期処理で削除します。</p>
      </Card>
    );
  return (
    <>
      <Card className="gap-4 p-5 sm:p-7">
        <p className="break-all text-xs text-gray-600">受付番号：{r.id}</p>
        <p className="text-sm">
          {kinds[r.kind]} ／ {games[r.game]} ／ {r.author === "account" ? "登録者" : "ゲスト"}
          {r.internal ? "（運営・テスト）" : ""}
        </p>
        <p className="text-xs text-gray-600">
          受信：{date(r.receivedAtMs)} ／ 保存期限：{date(r.expiresAtMs)}
          <br />
          初回確認：{r.firstReviewedAtMs === null ? "未確認" : date(r.firstReviewedAtMs)}
        </p>
        <section>
          <h2 className="mb-2 font-bold">内容</h2>
          <p className="whitespace-pre-wrap break-words text-sm">{r.body}</p>
        </section>
        {r.expectation && (
          <section>
            <h2 className="mb-2 font-bold">期待・目的</h2>
            <p className="whitespace-pre-wrap break-words text-sm">{r.expectation}</p>
          </section>
        )}
        {r.steps && (
          <section>
            <h2 className="mb-2 font-bold">再現手順</h2>
            <p className="whitespace-pre-wrap break-words text-sm">{r.steps}</p>
          </section>
        )}
        {r.hasAttachment && (
          <section>
            <h2 className="mb-2 font-bold">添付画像（非公開）</h2>
            <img
              src={`/api/admin/feedback/${r.id}/attachment`}
              alt="投稿に添付されたスクリーンショット"
              className="max-h-[600px] max-w-full object-contain"
            />
          </section>
        )}
        {r.technical && (
          <details className="text-sm">
            <summary className="min-h-11 cursor-pointer py-3">技術情報</summary>
            <div className="break-words space-y-2">
              <p>
                画面：{r.technical.page} ／ 対象：{games[r.technical.game]}
              </p>
              <p>ブラウザ：{r.technical.browser}</p>
              <p>
                サイズ：{r.technical.width}×{r.technical.height} ／ ビルド：{r.technical.build}
              </p>
              {r.technical.room && (
                <p>
                  部屋：{r.technical.room.id}
                  <br />
                  世代：{r.technical.room.instanceId}
                  <br />
                  局：{r.technical.room.roundId ?? "—"}
                </p>
              )}
            </div>
          </details>
        )}
      </Card>
      <Card className="gap-4 p-5">
        <h2 className="font-bold">対応の記録</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="text-sm">
            対応状況
            <select
              className={`${field} mt-1`}
              value={status}
              disabled={busy}
              onChange={(e) => {
                setStatus(e.target.value as FeedbackRecord["status"]);
                setPublished(false);
              }}
            >
              <Options values={statuses} />
            </select>
          </label>
          <label className="text-sm">
            優先度
            <select
              className={`${field} mt-1`}
              value={priority}
              disabled={busy}
              onChange={(e) => setPriority(e.target.value as FeedbackRecord["priority"])}
            >
              <Options values={priorities} />
            </select>
          </label>
          <label className="text-sm">
            テーマ
            <select
              className={`${field} mt-1`}
              value={topicId}
              disabled={busy}
              onChange={(e) => setTopicId(e.target.value)}
            >
              <option value="">未分類</option>
              {topics.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="text-sm">
          運営メモ{status === "declined" ? "（見送りの理由・必須）" : ""}
          <textarea
            className={`${field} mt-1`}
            rows={4}
            value={note}
            disabled={busy}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
        <label className="text-sm">
          関連GitHub Issue
          <input
            className={`${field} mt-1`}
            type="url"
            value={issueUrl}
            disabled={busy}
            placeholder="https://github.com/所有者/リポジトリ/issues/番号"
            onChange={(e) => setIssueUrl(e.target.value)}
          />
        </label>
        {status === "done" && (
          <label className="flex min-h-11 gap-2 items-center text-sm">
            <input
              type="checkbox"
              checked={published}
              disabled={busy}
              onChange={(e) => setPublished(e.target.checked)}
            />
            本番で公開・動作を確認しました
          </label>
        )}
        <ErrorMessage error={message} status={errorStatus} />
        {errorStatus === 409 && (
          <p className="text-sm">
            入力を保持しています。必要なメモを控えてから「再取得」で最新の投稿を確認してください。
          </p>
        )}
        <div>
          <Button onPress={() => void save()} isDisabled={busy}>
            {busy ? "処理中…" : "対応を保存"}
          </Button>
        </div>
        <div className="border-t pt-4">
          <label className="flex min-h-11 gap-2 items-center text-sm">
            <input
              type="checkbox"
              checked={confirmDelete}
              disabled={busy}
              onChange={(e) => setConfirmDelete(e.target.checked)}
            />
            投稿と画像を削除することを確認しました
          </label>
          <Button
            className="bg-red-700 text-white"
            isDisabled={busy || !confirmDelete}
            onPress={() => void save(true)}
          >
            投稿を削除
          </Button>
        </div>
      </Card>
      <Card className="gap-3 p-5">
        <h2 className="font-bold">編集履歴</h2>
        {detail.history.length === 0 ? (
          <p className="text-sm">編集履歴はありません。</p>
        ) : (
          detail.history.map((h, index) => (
            <div key={index} className="border-t pt-3 text-sm">
              <p>
                {date(h.atMs)} ／ {h.admin}
              </p>
              <ul className="mt-2 space-y-1">
                {Object.entries(h.changes).map(([key, v]) => {
                  const change = v as { before: unknown; after: unknown };
                  const label =
                    {
                      status: "対応状況",
                      priority: "優先度",
                      topicId: "テーマ",
                      note: "運営メモ",
                      issueUrl: "関連Issue",
                    }[key] ?? key;
                  const value = (raw: unknown) =>
                    key === "status"
                      ? statuses[raw as keyof typeof statuses]
                      : key === "priority"
                        ? priorities[raw as keyof typeof priorities]
                        : key === "topicId"
                          ? (topics.find((t) => t.id === raw)?.name ?? "未分類")
                          : String(raw || "なし");
                  return (
                    <li key={key} className="break-words whitespace-pre-wrap">
                      {label}：{value(change.before)} → {value(change.after)}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))
        )}
      </Card>
    </>
  );
}
