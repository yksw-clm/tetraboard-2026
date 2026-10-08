import { useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { Button, Card, Spinner } from "@heroui/react";
import {
  announcementAdminListSchema,
  announcementFirstLine,
  announcementInputSchema,
  announcementKindLabels,
  announcementRecordSchema,
  type AnnouncementInput,
  type AnnouncementRecord,
} from "@tetraboard/protocol";
import { gameCatalog, gameIds } from "@tetraboard/protocol/games";
import { useAdminData } from "./useAdminData";
import { AdminApiError, adminMutation } from "./api";
const parseList = (body: unknown) => announcementAdminListSchema.parse(body);
const parseRecord = (body: unknown) => announcementRecordSchema.parse(body);
const field = "w-full rounded-lg border border-gray-300 bg-white p-3 text-sm disabled:opacity-60";
export function announcementToday(now = Date.now()) {
  return new Date(now + 9 * 3600000).toISOString().slice(0, 10);
}
function ErrorMessage({ message, status }: { message: string | null; status?: number }) {
  return message ? (
    <div role="alert" className="rounded-lg bg-red-50 p-4 text-sm text-red-800">
      {message}
      {status === 401 && (
        <a href="/login?destination=admin" className="ml-3 underline">
          ログインへ
        </a>
      )}
    </div>
  ) : null;
}
export function Announcements() {
  const [search] = useSearchParams();
  const list = useAdminData(`/api/admin/announcements?${search}`, parseList);
  return (
    <div className="space-y-5 wrap-anywhere">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">お知らせ</h1>
        <Link className="text-brand underline" to="/announcements/new">
          お知らせを作成
        </Link>
        <Button onPress={list.refresh} isDisabled={list.loading}>
          更新
        </Button>
      </div>
      <ErrorMessage message={list.error} status={list.status} />
      {list.loading && <p role="status">読み込んでいます…</p>}
      {list.data && (
        <>
          {list.data.announcements.length === 0 && <p>お知らせはありません。</p>}
          {list.data.announcements.map((entry) => (
            <Card className="gap-2 p-5" key={entry.id}>
              <p className="text-sm text-gray-600">
                {entry.date} ／ {announcementKindLabels[entry.kind]} ／{" "}
                {entry.published ? "公開" : "非公開"}
              </p>
              <Link to={`/announcements/${entry.id}`} className="font-bold text-brand underline">
                {entry.title}
              </Link>
              <p className="text-sm">
                ロビー掲載：
                {entry.lobbyGames.map((game) => gameCatalog[game].name).join("・") || "なし"}
              </p>
            </Card>
          ))}
          {list.data.nextCursor && (
            <Link
              className="text-brand underline"
              to={`/announcements?cursor=${encodeURIComponent(list.data.nextCursor)}`}
            >
              もっと見る
            </Link>
          )}
        </>
      )}
      {search.has("cursor") && (
        <Link className="text-brand underline" to="/announcements">
          最新のお知らせへ
        </Link>
      )}
    </div>
  );
}
export function AnnouncementCreatePage() {
  return <AnnouncementEditor />;
}
export function AnnouncementEditPage() {
  const { id } = useParams();
  const data = useAdminData(`/api/admin/announcements/${id}`, parseRecord);
  return (
    <div className="space-y-5">
      <ErrorMessage message={data.error} status={data.status} />
      {data.loading && <p role="status">読み込んでいます…</p>}
      {!data.data && (
        <Button isDisabled={data.loading} onPress={data.refresh}>
          再試行
        </Button>
      )}
      {data.data && (
        <AnnouncementEditor
          key={`${id}:${data.data.version}`}
          initial={data.data}
          reload={data.refresh}
        />
      )}
    </div>
  );
}
function AnnouncementEditor({
  initial,
  reload,
}: {
  initial?: AnnouncementRecord;
  reload?: () => void;
}) {
  const navigate = useNavigate();
  const [draft, setDraft] = useState<AnnouncementInput | null>(
    () =>
      initial ?? {
        title: "",
        body: "",
        date: announcementToday(),
        kind: "other",
        published: false,
        lobbyGames: [],
      },
  );
  const [saved, setSaved] = useState(initial);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<number>();
  const [success, setSuccess] = useState(false);
  function change(patch: Partial<AnnouncementInput>) {
    setDraft((old) => old && { ...old, ...patch });
    setSuccess(false);
  }
  async function save() {
    if (lock.current || !draft) return;
    // 管理用のID・日時・更新番号を入力から切り離して検証します。
    const input = announcementInputSchema.safeParse({
      title: draft.title,
      body: draft.body,
      date: draft.date,
      kind: draft.kind,
      published: draft.published,
      lobbyGames: draft.lobbyGames,
    });
    if (!input.success) {
      setError("タイトルは1〜80文字、説明文は1〜2,000文字で入力し、日付を確認してください。");
      return;
    }
    lock.current = true;
    setBusy(true);
    setError(null);
    setStatus(undefined);
    setSuccess(false);
    try {
      const value = parseRecord(
        await adminMutation(
          saved ? `/api/admin/announcements/${saved.id}` : "/api/admin/announcements",
          saved ? "PATCH" : "POST",
          saved ? { ...input.data, version: saved.version } : input.data,
        ),
      );
      setSaved(value);
      setDraft(value);
      setSuccess(true);
      if (!saved) navigate(`/announcements/${value.id}`, { replace: true });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存できませんでした。");
      if (cause instanceof AdminApiError) {
        setStatus(cause.status);
        if ([401, 403].includes(cause.status)) {
          setDraft(null);
          setSaved(undefined);
          reload?.();
        }
      }
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="space-y-5 wrap-anywhere">
      <Link to="/announcements" className="text-brand underline">
        お知らせ一覧へ
      </Link>
      <h1 className="text-2xl font-bold">{initial ? "お知らせを編集" : "お知らせを作成"}</h1>
      <ErrorMessage message={error} status={status} />
      {success && <p role="status">保存しました。</p>}
      {draft && (
        <Card className="gap-5 p-5 sm:p-7">
          <fieldset disabled={busy} className="space-y-4">
            <label className="block space-y-2">
              <span>タイトル（必須・80文字まで）</span>
              <input
                className={field}
                value={draft.title}
                onChange={(e) => change({ title: e.target.value })}
              />
            </label>
            <label className="block space-y-2">
              <span>説明文（必須・2,000文字まで）</span>
              <textarea
                className={field}
                rows={8}
                value={draft.body}
                onChange={(e) => change({ body: e.target.value })}
              />
            </label>
            <label className="block space-y-2">
              <span>日付</span>
              <input
                className={field}
                type="date"
                value={draft.date}
                onChange={(e) => change({ date: e.target.value })}
              />
            </label>
            <p className="text-sm text-gray-600">
              日付は表示・並び順に使います。公開予約ではありません。
            </p>
            <label className="block space-y-2">
              <span>種別</span>
              <select
                className={field}
                value={draft.kind}
                onChange={(e) => change({ kind: e.target.value as AnnouncementInput["kind"] })}
              >
                {Object.entries(announcementKindLabels).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex min-h-11 items-center gap-3">
              <input
                type="checkbox"
                checked={draft.published}
                onChange={(e) => change({ published: e.target.checked })}
              />
              公開する
            </label>
            <fieldset className="space-y-2">
              <legend>ロビー掲載先</legend>
              {gameIds.map((game) => (
                <label key={game} className="flex min-h-11 items-center gap-3">
                  <input
                    type="checkbox"
                    checked={draft.lobbyGames.includes(game)}
                    onChange={(e) =>
                      change({
                        lobbyGames: e.target.checked
                          ? [...draft.lobbyGames, game]
                          : draft.lobbyGames.filter((value) => value !== game),
                      })
                    }
                  />
                  {gameCatalog[game].name}
                </label>
              ))}
            </fieldset>
            <p className="text-sm text-gray-600">
              未選択ならお知らせ一覧だけに掲載します。公開状態と掲載先は保存後に反映されます。
            </p>
          </fieldset>
          <section
            aria-label="ロビー表示プレビュー"
            className="rounded-lg border border-gray-200 p-4 space-y-2"
          >
            <h2 className="text-sm text-gray-600">ロビー表示プレビュー</h2>
            <p className="font-bold">{draft.title || "タイトル"}</p>
            <p className="text-sm">{announcementFirstLine(draft.body) || "説明文の1行目"}</p>
            <span className="text-sm text-brand underline">お知らせへ</span>
          </section>
          {status === 409 && reload && (
            <>
              <p className="text-sm">
                入力を確認してから読み直してください。読み直すと最新の保存内容に置き換わります。
              </p>
              <Button onPress={reload} isDisabled={busy}>
                最新データを読み直す
              </Button>
            </>
          )}
          <Button
            onPress={() => void save()}
            isDisabled={busy}
            aria-label="保存"
            className="relative self-start"
          >
            <span className={busy ? "opacity-0" : ""}>保存</span>
            {busy && (
              <span aria-hidden="true" className="absolute inset-0 grid place-items-center">
                <Spinner size="sm" />
              </span>
            )}
          </Button>
        </Card>
      )}
    </div>
  );
}
