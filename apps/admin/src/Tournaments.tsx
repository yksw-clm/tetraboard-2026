import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { Avatar, Button, Card, Spinner } from "@heroui/react";
import {
  tournamentAdminListSchema,
  tournamentAdminEntriesSchema,
  tournamentInputSchema,
  tournamentRecordSchema,
  tournamentFixedRules,
  formatTournamentPoints,
  type TournamentInput,
  type TournamentRecord,
} from "@tetraboard/protocol";
import { AdminApiError, adminMutation } from "./api";
import { useAdminData } from "./useAdminData";
import { useAdminPages } from "./useAdminPages";
import { LobbyChat } from "./LobbyChat";

const parseList = (body: unknown) => tournamentAdminListSchema.parse(body);
const parseRecord = (body: unknown) => tournamentRecordSchema.parse(body);
const parseEntries = (body: unknown) => tournamentAdminEntriesSchema.parse(body);
const field = "w-full rounded-lg border border-gray-300 bg-white p-3 text-sm disabled:opacity-60";
const statusLabels = {
  draft: "下書き",
  upcoming: "開催前・エントリー受付中",
  active: "開催中",
  settling: "開催終了・結果発表待ち",
  finished: "開催終了・結果確定",
};
const entryStatusLabels = {
  idle: "待機していません",
  waiting: "対戦相手を待機中",
  matched: "入室待ち",
  playing: "対局中",
};
const dateTime = (value: number | null) =>
  value === null ? "未設定" : new Date(value).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
export function tournamentDateInput(value: number | null) {
  return value === null ? "" : new Date(value + 9 * 3600000).toISOString().slice(0, 16);
}
export function tournamentDateValue(value: string): number | null {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return Number.NaN;
  const time = Date.parse(`${value}:00+09:00`);
  return Number.isFinite(time) && tournamentDateInput(time) === value ? time : Number.NaN;
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
      {status === 403 && (
        <a href="/admin" className="ml-3 underline">
          管理画面を開き直す
        </a>
      )}
    </div>
  ) : null;
}

export function Tournaments() {
  const list = useAdminPages("/api/admin/tournaments", parseList);
  const tournaments = list.pages.flatMap((page) => page.tournaments);
  return (
    <div className="space-y-5 wrap-anywhere">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">大会</h1>
        <Link to="/tournaments/new" className="text-brand underline">
          大会を作成
        </Link>
        <Button onPress={list.refresh} isDisabled={list.loading || list.denied}>
          更新
        </Button>
      </div>
      <ErrorMessage message={list.error} status={list.status} />
      {list.loading && <p role="status">大会を読み込んでいます…</p>}
      {!!list.pages.length && !tournaments.length && <p>大会はありません。</p>}
      {tournaments.map((tournament) => (
        <Card className="gap-2 p-5" key={tournament.key}>
          <p className="text-sm text-gray-600">
            {statusLabels[tournament.status]}
            {tournament.id !== null && ` ／ 大会番号 ${tournament.id}`}
          </p>
          <Link to={`/tournaments/${tournament.key}`} className="font-bold text-brand underline">
            {tournament.name}
          </Link>
          <p className="text-sm">
            開催日時（日本時間）：{dateTime(tournament.startsAtMs)} 〜{" "}
            {dateTime(tournament.endsAtMs)}
          </p>
          <p className="text-sm">エントリー {tournament.entryCount}人</p>
        </Card>
      ))}
      {list.cursor && (
        <Button onPress={() => void list.more()} isDisabled={list.loadingMore}>
          {list.loadingMore ? "読み込んでいます…" : "次の50件"}
        </Button>
      )}
    </div>
  );
}
export function TournamentCreatePage() {
  return <TournamentEditor />;
}
export function TournamentEditPage() {
  const { key } = useParams();
  return <TournamentDetail key={key} tournamentKey={key!} />;
}
function TournamentDetail({ tournamentKey }: { tournamentKey: string }) {
  const data = useAdminData(`/api/admin/tournaments/${tournamentKey}`, parseRecord);
  const [denied, setDenied] = useState<{ message: string; status: number } | null>(null);
  const loseAccess = useCallback(
    (message: string, status: number) => {
      data.discard();
      setDenied({ message, status });
    },
    [data.discard],
  );
  const unauthorized = denied || [401, 403].includes(data.status ?? 0);
  return (
    <div className="space-y-5">
      <ErrorMessage
        message={denied?.message ?? data.error}
        status={denied?.status ?? data.status}
      />
      {data.loading && !unauthorized && <p role="status">大会を読み込んでいます…</p>}
      {!data.data && !unauthorized && (
        <Button isDisabled={data.loading} onPress={data.refresh}>
          再試行
        </Button>
      )}
      {data.data && !unauthorized && (
        <>
          <TournamentEditor
            key={`${tournamentKey}:${data.data.version}`}
            initial={data.data}
            reload={data.refresh}
            onDenied={loseAccess}
          />
          <TournamentEntries tournamentKey={tournamentKey} onDenied={loseAccess} />
          {data.data.published && data.data.id !== null && (
            <LobbyChat key={data.data.id} tournamentId={data.data.id} />
          )}
        </>
      )}
    </div>
  );
}
type TournamentDraft = Omit<TournamentInput, "startsAtMs" | "endsAtMs"> & {
  startsAt: string;
  endsAt: string;
};
function draftFromRecord(record?: TournamentRecord): TournamentDraft {
  return {
    name: record?.name ?? "",
    description: record?.description ?? "",
    rulesDescription: record?.rulesDescription ?? "",
    startsAt: tournamentDateInput(record?.startsAtMs ?? null),
    endsAt: tournamentDateInput(record?.endsAtMs ?? null),
  };
}
function TournamentEditor({
  initial,
  reload,
  onDenied,
}: {
  initial?: TournamentRecord;
  reload?: () => void;
  onDenied?: (message: string, status: number) => void;
}) {
  const navigate = useNavigate();
  const [draft, setDraft] = useState<TournamentDraft | null>(() => draftFromRecord(initial));
  const [saved, setSaved] = useState(initial);
  const [preview, setPreview] = useState<TournamentInput | null>(null);
  const [busy, setBusy] = useState<"save" | "publish" | null>(null);
  const lock = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<number>();
  const [success, setSuccess] = useState<string | null>(null);
  function change(patch: Partial<TournamentDraft>) {
    setDraft((old) => old && { ...old, ...patch });
    setPreview(null);
    setSuccess(null);
  }
  function input(): TournamentInput | null {
    if (!draft) return null;
    const parsed = tournamentInputSchema.safeParse({
      name: draft.name,
      description: draft.description,
      rulesDescription: draft.rulesDescription,
      startsAtMs: saved?.published ? saved.startsAtMs : tournamentDateValue(draft.startsAt),
      endsAtMs: saved?.published ? saved.endsAtMs : tournamentDateValue(draft.endsAt),
    });
    if (!parsed.success) {
      setError(
        "大会名は1〜80文字、詳細・大会ごとの説明文は各2,000文字までで入力し、開始・終了日時を確認してください。",
      );
      return null;
    }
    return parsed.data;
  }
  async function mutate(action: "save" | "publish") {
    if (lock.current || !draft) return;
    const value = input();
    if (!value) return;
    if (action === "publish") {
      if (!saved || !preview || JSON.stringify(draft) !== JSON.stringify(draftFromRecord(saved))) {
        setError("最新の入力を保存してからプレビューを確認してください。");
        return;
      }
      if (saved.startsAtMs === null || saved.endsAtMs === null || saved.startsAtMs <= Date.now()) {
        setError("公開には未来の開始日時と、その後の終了日時が必要です。");
        return;
      }
    }
    lock.current = true;
    setBusy(action);
    setError(null);
    setStatus(undefined);
    setSuccess(null);
    try {
      const record = parseRecord(
        await adminMutation(
          action === "publish"
            ? `/api/admin/tournaments/${saved!.key}/publish`
            : saved
              ? `/api/admin/tournaments/${saved.key}`
              : "/api/admin/tournaments",
          action === "save" && saved ? "PATCH" : "POST",
          action === "publish"
            ? { version: saved!.version }
            : saved
              ? { ...value, version: saved.version }
              : value,
        ),
      );
      setSaved(record);
      setDraft(draftFromRecord(record));
      setPreview(null);
      setSuccess(
        action === "publish" ? "公開しました。エントリー受付を開始しました。" : "保存しました。",
      );
      if (!saved) navigate(`/tournaments/${record.key}`, { replace: true });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "保存できませんでした。";
      setError(message);
      if (cause instanceof AdminApiError) {
        setStatus(cause.status);
        if ([401, 403].includes(cause.status)) {
          setDraft(null);
          setSaved(undefined);
          setPreview(null);
          onDenied?.(message, cause.status);
        }
      }
    } finally {
      lock.current = false;
      setBusy(null);
    }
  }
  return (
    <div className="space-y-5 wrap-anywhere">
      <Link to="/tournaments" className="text-brand underline">
        大会一覧へ
      </Link>
      <h1 className="text-2xl font-bold">{initial ? "大会を編集" : "大会を作成"}</h1>
      <ErrorMessage message={error} status={status} />
      {success && <p role="status">{success}</p>}
      {draft && (
        <>
          <Card className="gap-5 p-5 sm:p-7">
            {saved && (
              <p className="text-sm text-gray-600">
                {statusLabels[saved.status]} ／ 更新番号 {saved.version}
                {saved.id !== null && ` ／ 大会番号 ${saved.id}`}
              </p>
            )}
            {saved?.published && (
              <a
                href={`/tournaments/${saved.id}`}
                target="_blank"
                rel="noreferrer"
                className="text-brand underline"
              >
                公開ページを開く ↗
              </a>
            )}
            <fieldset disabled={busy !== null} className="space-y-4">
              <label className="block space-y-2">
                <span>大会名（必須・80文字まで）</span>
                <input
                  aria-label="大会名"
                  className={field}
                  value={draft.name}
                  onChange={(e) => change({ name: e.target.value })}
                />
              </label>
              <label className="block space-y-2">
                <span>大会の詳細（任意・2,000文字まで）</span>
                <textarea
                  aria-label="大会の詳細"
                  className={field}
                  rows={5}
                  value={draft.description}
                  onChange={(e) => change({ description: e.target.value })}
                />
              </label>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block space-y-2">
                  <span>開始日時（日本時間）</span>
                  <input
                    aria-label="開始日時（日本時間）"
                    type="datetime-local"
                    className={field}
                    disabled={saved?.published}
                    value={draft.startsAt}
                    onChange={(e) => change({ startsAt: e.target.value })}
                  />
                </label>
                <label className="block space-y-2">
                  <span>終了日時（日本時間）</span>
                  <input
                    aria-label="終了日時（日本時間）"
                    type="datetime-local"
                    className={field}
                    disabled={saved?.published}
                    value={draft.endsAt}
                    onChange={(e) => change({ endsAt: e.target.value })}
                  />
                </label>
              </div>
              <p className="text-sm text-gray-600">
                {saved?.published
                  ? "公開後の開催日時は固定です。大会名・詳細・説明文は修正できます。"
                  : "下書きでは日時を空欄にできます。公開時は未来の開催日時が必要です。"}
              </p>
              <label className="block space-y-2">
                <span>大会ごとの説明文（任意・2,000文字まで）</span>
                <textarea
                  aria-label="大会ごとの説明文"
                  className={field}
                  rows={5}
                  value={draft.rulesDescription}
                  onChange={(e) => change({ rulesDescription: e.target.value })}
                />
              </label>
              <p className="text-sm text-gray-600">
                詳細・説明文は改行を保持するプレーンテキストです。固定ルールの対局・集計条件は変更できません。
              </p>
            </fieldset>
            <FixedRules />
            {status === 409 && reload && (
              <div className="space-y-3">
                <p className="text-sm">
                  入力を保持しています。入力を確認してから読み直してください。読み直すと最新の保存内容に置き換わります。
                </p>
                <Button onPress={reload} isDisabled={busy !== null}>
                  最新データを読み直す
                </Button>
              </div>
            )}
            <div className="flex flex-wrap gap-3">
              <Button
                onPress={() => void mutate("save")}
                isDisabled={busy !== null}
                aria-label="保存"
                className="relative"
              >
                <span className={busy === "save" ? "opacity-0" : ""}>保存</span>
                {busy === "save" && (
                  <span aria-hidden="true" className="absolute inset-0 grid place-items-center">
                    <Spinner size="sm" />
                  </span>
                )}
              </Button>
              <Button
                onPress={() => {
                  const value = input();
                  if (value) {
                    setPreview(value);
                    setError(null);
                  }
                }}
                isDisabled={busy !== null}
              >
                プレビュー
              </Button>
            </div>
          </Card>
          {preview && (
            <Card aria-label="大会ページのプレビュー" className="gap-4 p-5 sm:p-7">
              <p className="text-sm text-gray-600">大会ページのプレビュー</p>
              <h2 className="text-2xl font-bold">{preview.name}</h2>
              <p>
                開催日時（日本時間）：{dateTime(preview.startsAtMs)} 〜 {dateTime(preview.endsAtMs)}
              </p>
              <p>エントリー {saved?.entryCount ?? 0}人</p>
              {preview.description && <p className="whitespace-pre-wrap">{preview.description}</p>}
              <FixedRules />
              {preview.rulesDescription && (
                <section className="space-y-2">
                  <h3 className="font-bold">大会ごとの説明</h3>
                  <p className="whitespace-pre-wrap">{preview.rulesDescription}</p>
                </section>
              )}
              {!saved?.published && (
                <>
                  <p className="text-sm">
                    公開すると大会番号・開催日時・固定ルールが確定し、エントリー受付を開始します。公開後の非公開化・削除はできません。
                  </p>
                  <Button
                    onPress={() => void mutate("publish")}
                    isDisabled={
                      busy !== null ||
                      !saved ||
                      JSON.stringify(draft) !== JSON.stringify(draftFromRecord(saved))
                    }
                  >
                    {busy === "publish" ? "公開しています…" : "この内容で公開する"}
                  </Button>
                  {(!saved || JSON.stringify(draft) !== JSON.stringify(draftFromRecord(saved))) && (
                    <p className="text-sm">
                      公開する前に最新の入力を保存し、もう一度プレビューしてください。
                    </p>
                  )}
                </>
              )}
            </Card>
          )}
        </>
      )}
    </div>
  );
}
function FixedRules() {
  return (
    <section aria-label="固定ルール" className="space-y-2 rounded-lg bg-gray-50 p-4 text-sm">
      <h3 className="font-bold">固定ルール（大会ルール版1）</h3>
      {tournamentFixedRules.map((line) => (
        <p key={line}>{line}</p>
      ))}
    </section>
  );
}
function TournamentEntries({
  tournamentKey,
  onDenied,
}: {
  tournamentKey: string;
  onDenied: (message: string, status: number) => void;
}) {
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  return (
    <section aria-label="エントリー者一覧" className="space-y-4">
      <h2 className="text-xl font-bold">エントリー者一覧</h2>
      <p className="text-sm text-gray-600">
        未対局者を含む全エントリー者です。現在オンラインの人数ではありません。
      </p>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          setSearch(draft.trim());
        }}
      >
        <label className="min-w-0 flex-1 space-y-2">
          <span>名前・公開IDで検索</span>
          <input
            aria-label="名前・公開IDで検索"
            className={field}
            maxLength={100}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
        </label>
        <Button type="submit">検索</Button>
      </form>
      <EntryResults
        key={search}
        tournamentKey={tournamentKey}
        search={search}
        onDenied={onDenied}
      />
    </section>
  );
}
function EntryResults({
  tournamentKey,
  search,
  onDenied,
}: {
  tournamentKey: string;
  search: string;
  onDenied: (message: string, status: number) => void;
}) {
  const result = useAdminPages(
    `/api/admin/tournaments/${tournamentKey}/entries?${new URLSearchParams({ search })}`,
    parseEntries,
  );
  useEffect(() => {
    if (result.denied) onDenied(result.error ?? "権限がありません。", result.status!);
  }, [result.denied, result.error, result.status, onDenied]);
  const entries = result.pages.flatMap((page) => page.entries);
  return (
    <Card className="gap-4 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {!!result.pages.length && (
          <p>
            {search ? "検索結果" : "全エントリー"} {result.pages[0]!.total}人
          </p>
        )}
        <Button onPress={result.refresh} isDisabled={result.loading || result.denied}>
          エントリー者を更新
        </Button>
      </div>
      {result.loading && <p role="status">エントリー者を読み込んでいます…</p>}
      <ErrorMessage message={result.error} status={result.status} />
      {!!result.pages.length && !entries.length && <p>該当するエントリー者はいません。</p>}
      {!!entries.length && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr>
                {[
                  "プレイヤー",
                  "公開ID",
                  "エントリー日時（日本時間）",
                  "参加状態",
                  "対局数",
                  "勝ち点",
                ].map((label) => (
                  <th className="whitespace-nowrap p-3" key={label}>
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr
                  key={`${entry.username}:${entry.enteredAtMs}`}
                  className="border-t border-gray-200"
                >
                  <td className="p-3">
                    <div className="flex items-center gap-3">
                      <Avatar className="size-9 shrink-0">
                        <Avatar.Image src={entry.avatarUrl ?? undefined} alt="" />
                        <Avatar.Fallback>{entry.name.slice(0, 1)}</Avatar.Fallback>
                      </Avatar>
                      <span className="whitespace-nowrap">{entry.name}</span>
                    </div>
                  </td>
                  <td className="whitespace-nowrap p-3">
                    {entry.isGuest ? "ゲスト" : `@${entry.username}`}
                  </td>
                  <td className="whitespace-nowrap p-3">{dateTime(entry.enteredAtMs)}</td>
                  <td className="whitespace-nowrap p-3">{entryStatusLabels[entry.status]}</td>
                  <td className="p-3">{entry.games}</td>
                  <td className="p-3">{formatTournamentPoints(entry.pointsUnits)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {result.cursor && (
        <Button onPress={() => void result.more()} isDisabled={result.loadingMore}>
          {result.loadingMore ? "読み込んでいます…" : "次の50人"}
        </Button>
      )}
    </Card>
  );
}
