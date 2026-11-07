import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { Link } from "react-router";
import { badgeDefinitions, getBadgeIds, type Notification } from "@tetraboard/protocol";
import { gameCatalog } from "@tetraboard/protocol/games";
import { AppButton } from "../../shared/ui/AppButton";
import { AppDialog } from "../../shared/ui/AppDialog";
import { AppIcon } from "../../shared/ui/AppIcon";
import { BadgeImage } from "../badges/BadgeImage";
import { badgeToastTitle } from "../badges/badgeNotificationPresentation";
import { createAccountSelection } from "../account/useAccountSelection";
import { useNotificationCenter, type NotificationCenter } from "./NotificationContext";

function title(n: Notification) {
  if (n.kind === "announcement") return n.announcement.title;
  if (n.kind === "badge") return badgeToastTitle(n.badge);
  return `${n.tournament.name}で${n.tournament.tied ? "同率" : ""}${n.tournament.rank === 1 ? "優勝" : "準優勝"}しました！`;
}
const labels = { announcement: "運営からのお知らせ", tournament: "大会結果", badge: "バッジ" };
function NotificationDetails({
  notification: n,
  center,
  setRows,
  onClose,
}: {
  notification: Notification;
  center: NotificationCenter;
  setRows: Dispatch<SetStateAction<Notification[]>>;
  onClose: () => void;
}) {
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const markRead = center.read;
  useEffect(() => {
    let active = true;
    void markRead(n)
      .then(() => {
        if (active) {
          setError(false);
          setRows((previous) =>
            previous.map((row) => (row.id === n.id ? { ...row, read: true } : row)),
          );
        }
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [n, markRead, retry, setRows]);
  const target =
    n.kind === "announcement"
      ? `/updates/${n.announcement.id}`
      : n.kind === "tournament"
        ? `/tournaments/${n.tournament.id}`
        : "/account";
  return (
    <article className="space-y-4 wrap-anywhere">
      <h2 className="text-lg font-bold">{title(n)}</h2>
      {n.kind === "announcement" ? (
        <p className="whitespace-pre-wrap text-sm leading-relaxed">{n.announcement.body}</p>
      ) : n.kind === "tournament" ? (
        <p className="text-sm">
          {n.tournament.name}の結果が確定しました。{n.tournament.tied ? "同率" : ""}
          {n.tournament.rank === 1 ? "優勝" : "準優勝"}おめでとうございます！
        </p>
      ) : (
        <>
          <p className="text-sm">{gameCatalog[n.badge.game].name}</p>
          <div className="flex flex-wrap gap-4">
            {getBadgeIds(n.badge.game)
              .flatMap((id) => n.badge.badges.filter((b) => b.id === id))
              .map((b) => (
                <div key={b.id} className="flex flex-col items-center gap-1 text-sm">
                  <BadgeImage game={n.badge.game} {...b} size={56} />
                  <span>
                    {badgeDefinitions[b.id].name}・星{b.tier}
                  </span>
                  <span>
                    累計{b.value}
                    {badgeDefinitions[b.id].unit}
                  </span>
                </div>
              ))}
          </div>
        </>
      )}
      {error && (
        <div role="alert" className="space-y-2 text-sm">
          <p>既読を保存できませんでした。</p>
          <AppButton appearance="secondary" size="compact" onPress={() => setRetry((v) => v + 1)}>
            既読を再試行
          </AppButton>
        </div>
      )}
      <Link
        className="inline-flex min-h-11 items-center text-sm text-brand underline"
        to={target}
        state={
          n.kind === "badge"
            ? { accountSelection: createAccountSelection(n.badge.game) }
            : undefined
        }
        onClick={onClose}
      >
        {n.kind === "announcement"
          ? "元の記事へ"
          : n.kind === "tournament"
            ? "大会結果へ"
            : "マイページでバッジを見る"}
      </Link>
    </article>
  );
}
function NotificationDialog({
  center,
  onClose,
}: {
  center: NotificationCenter;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<Notification[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [upperBound, setUpperBound] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [pending, setPending] = useState(false);
  const [pendingSource, setPendingSource] = useState("initial");
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Notification | null>(null);
  const mounted = useRef(true);
  const requestVersion = useRef(0);
  const scroll = useRef<HTMLDivElement>(null);
  const scrollTop = useRef(0);
  const detailTarget = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (selected && scroll.current) scroll.current.scrollTop = 0;
  }, [selected]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function load(next?: string) {
    setPendingSource(next ? "more" : "refresh");
    const version = ++requestVersion.current;
    setPending(true);
    setError(null);
    try {
      const page = await center.list(next);
      if (!mounted.current || version !== requestVersion.current) return;
      setRows((previous) =>
        next
          ? [...previous, ...page.notifications.filter((n) => !previous.some((p) => p.id === n.id))]
          : page.notifications,
      );
      setCursor(page.nextCursor);
      setUpperBound(page.upperBound);
      setLoaded(true);
    } catch {
      if (mounted.current && version === requestVersion.current)
        setError("お知らせを取得できませんでした。");
    } finally {
      if (mounted.current && version === requestVersion.current) setPending(false);
    }
  }
  useEffect(() => {
    void load();
    void center.refresh();
    // ダイアログを開いたときだけ初期一覧を取得し、戻るときは保持します。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  async function open(id: number) {
    detailTarget.current = id;
    setPendingSource("detail");
    const version = ++requestVersion.current;
    scrollTop.current = scroll.current?.scrollTop ?? 0;
    setPending(true);
    setError(null);
    try {
      const detail = await center.detail(id);
      if (mounted.current && version === requestVersion.current) setSelected(detail);
    } catch {
      if (mounted.current && version === requestVersion.current)
        setError("詳細を取得できませんでした。項目を選び直してください。");
    } finally {
      if (mounted.current && version === requestVersion.current) setPending(false);
    }
  }
  async function allRead() {
    setPendingSource("read-all");
    setPending(true);
    setError(null);
    try {
      await center.readAll(upperBound);
      if (mounted.current)
        setRows((previous) => previous.map((n) => ({ ...n, read: n.id <= upperBound || n.read })));
    } catch {
      if (mounted.current) setError("既読を保存できませんでした。再試行してください。");
    } finally {
      if (mounted.current) setPending(false);
    }
  }
  return (
    <AppDialog
      title="お知らせ"
      onClose={onClose}
      scrollBody
      bodyRef={scroll}
      footer={
        selected && (
          <AppButton
            appearance="secondary"
            isIconOnly
            aria-label="一覧に戻る"
            className="size-11 min-w-11 p-0"
            onPress={() => {
              const id = selected.id;
              setSelected(null);
              requestAnimationFrame(() => {
                const body = scroll.current;
                body
                  ?.querySelector<HTMLButtonElement>(`[data-notification-id="${id}"]`)
                  ?.focus({ preventScroll: true });
                if (body) body.scrollTop = scrollTop.current;
              });
            }}
          >
            <AppIcon name="arrow" className="rotate-180" />
          </AppButton>
        )
      }
    >
      {center.storageError && (
        <p role="status" className="mb-3 text-sm">
          既読はこの画面で反映されていますが、再読み込み後は保持されない場合があります。
        </p>
      )}
      {selected ? (
        <NotificationDetails
          notification={selected}
          center={center}
          setRows={setRows}
          onClose={onClose}
        />
      ) : (
        <>
          <div className="mb-3 flex flex-wrap gap-2">
            <AppButton
              appearance="secondary"
              size="compact"
              isIconOnly
              aria-label="お知らせを更新"
              className="size-11 min-w-11 p-0"
              isDisabled={pending}
              isPending={pending && pendingSource === "refresh"}
              onPress={() => void load()}
            >
              <AppIcon name="refresh" />
            </AppButton>
            <AppButton
              appearance="secondary"
              size="compact"
              className="min-h-11"
              isDisabled={pending || !loaded}
              isPending={pending && pendingSource === "read-all"}
              onPress={() => void allRead()}
            >
              すべて既読にする
            </AppButton>
          </div>
          {pending && !loaded && <p role="status">お知らせを読み込んでいます…</p>}
          {error && (
            <div role="alert" className="mb-3 text-sm">
              <p>{error}</p>
              <AppButton
                appearance="secondary"
                size="compact"
                isDisabled={pending}
                onPress={() => {
                  if (pendingSource === "read-all") void allRead();
                  else if (pendingSource === "detail" && detailTarget.current !== null)
                    void open(detailTarget.current);
                  else void load(pendingSource === "more" && cursor ? cursor : undefined);
                }}
              >
                再試行
              </AppButton>
            </div>
          )}
          {loaded && !rows.length && <p className="text-sm">お知らせはありません。</p>}
          <div className="divide-y divide-line">
            {rows.map((n) => (
              <button
                key={n.id}
                data-notification-id={n.id}
                type="button"
                disabled={pending}
                onClick={() => void open(n.id)}
                className="flex w-full flex-col gap-2 border-0 bg-transparent px-1 py-4 text-left text-ink hover:bg-surface-muted focus-visible:outline-[3px] focus-visible:outline-focus disabled:cursor-wait"
              >
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                  <span>{labels[n.kind]}</span>
                  <time dateTime={new Date(n.createdAtMs).toISOString()}>
                    {new Date(n.createdAtMs).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}
                  </time>
                  {!n.read && <span className="text-danger font-bold">未読</span>}
                </span>
                <span className="text-sm font-bold wrap-anywhere">{title(n)}</span>
              </button>
            ))}
          </div>
          {cursor && (
            <AppButton
              appearance="secondary"
              size="compact"
              isPending={pending && pendingSource === "more"}
              isDisabled={pending}
              onPress={() => void load(cursor)}
            >
              もっと見る
            </AppButton>
          )}
        </>
      )}
    </AppDialog>
  );
}
export function NotificationBell() {
  const center = useNotificationCenter();
  const [openFor, setOpenFor] = useState<string | null>(null);
  const anchor = useRef<HTMLButtonElement>(null);
  const register = center?.registerHeader;
  useEffect(() => register?.(), [register]);
  const identity = center?.identity;
  const open = Boolean(identity && openFor === identity);
  function close() {
    setOpenFor(null);
    requestAnimationFrame(() => anchor.current?.focus({ preventScroll: true }));
  }
  return (
    <>
      <AppButton
        ref={anchor}
        appearance="quiet"
        size="compact"
        isIconOnly
        isDisabled={Boolean(center && !identity)}
        aria-label={center?.hasUnread ? "お知らせ（未読あり）" : "お知らせ"}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="relative size-11 min-w-11 p-0"
        onPress={() => setOpenFor(identity ?? null)}
      >
        <AppIcon name="bell" />
        {center?.hasUnread && (
          <span
            aria-hidden="true"
            className="absolute right-2 top-2 size-2 rounded-full bg-red-600"
          />
        )}
      </AppButton>
      {center?.error && (
        <span role="status" className="sr-only">
          {center.error}
        </span>
      )}
      {open && center && identity && (
        <NotificationDialog key={identity} center={center} onClose={close} />
      )}
    </>
  );
}
