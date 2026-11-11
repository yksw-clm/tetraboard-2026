import { useEffect, useRef, useState } from "react";
import { trackingLinksSchema, trackingLinkSchema, type TrackingLink } from "@tetraboard/protocol";
import { useAdminData } from "./useAdminData";
import { adminMutation, adminRequest } from "./api";
import { Card } from "./components/ui/card";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "./components/ui/dialog";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "./components/ui/table";
const parseLinks = (b: unknown) => trackingLinksSchema.parse(b);
const linkUrl = (id: number) => new URL(`/?utm=${id}`, window.location.origin).href;
export function TrackingLinks() {
  const result = useAdminData("/api/admin/tracking-links", parseLinks);
  const [extra, setExtra] = useState<TrackingLink[]>([]),
    [cursor, setCursor] = useState<number | null | undefined>(),
    [loading, setLoading] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [notice, setNotice] = useState<string | null>(null),
    [created, setCreated] = useState<TrackingLink | null>(null);
  const [label, setLabel] = useState(""),
    [medium, setMedium] = useState(""),
    [campaign, setCampaign] = useState("");
  const [editing, setEditing] = useState<TrackingLink | null>(null),
    [editLabel, setEditLabel] = useState(""),
    [overrides, setOverrides] = useState<Record<number, TrackingLink>>({});
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  const next = cursor === undefined ? result.data?.nextCursor : cursor;
  const rows = result.data ? [...result.data.links, ...extra].map((l) => overrides[l.id] ?? l) : [];
  async function more() {
    if (!next || loading || busy) return;
    const controller = new AbortController();
    active.current = controller;
    setLoading(true);
    setError(null);
    try {
      const data = parseLinks(
        await adminRequest(`/api/admin/tracking-links?after=${next}`, controller.signal),
      );
      if (!controller.signal.aborted) {
        setExtra((v) => [...v, ...data.links]);
        setCursor(data.nextCursor);
      }
    } catch {
      if (!controller.signal.aborted) setError("追加取得できません。再試行してください。");
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }
  async function create() {
    if (busy || loading) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const l = trackingLinkSchema.parse(
        await adminMutation("/api/admin/tracking-links", "POST", {
          label: label.trim(),
          medium: medium.trim(),
          campaign: campaign.trim(),
        }),
      );
      setCreated(l);
      setLabel("");
      setMedium("");
      setCampaign("");
      setExtra([]);
      setCursor(undefined);
      result.refresh();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "発行できません。結果が不明な場合は一覧を確認してください。",
      );
    } finally {
      setBusy(false);
    }
  }
  async function update(link: TrackingLink, values: { label?: string; archived?: boolean }) {
    if (busy || loading) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const l = trackingLinkSchema.parse(
        await adminMutation(`/api/admin/tracking-links/${link.id}`, "PATCH", values),
      );
      setOverrides((v) => ({ ...v, [l.id]: l }));
      if (created?.id === l.id) setCreated(l);
      setEditing(null);
      setNotice("計測リンクを更新しました。番号・媒体・施策と配布済みリンクの帰属は維持されます。");
    } catch (e) {
      setError(e instanceof Error ? e.message : "更新できません。");
    } finally {
      setBusy(false);
    }
  }
  async function copy(id: number) {
    try {
      await navigator.clipboard.writeText(linkUrl(id));
      setNotice("計測リンクをコピーしました。");
    } catch {
      setNotice("コピーできません。表示されたURLを選択してコピーしてください。");
    }
  }
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">計測リンク</h1>
      <p className="text-sm text-muted-foreground">
        1〜4は固定です。5以降は投稿や施策ごとに発行できます。番号・媒体・施策名は変更・再利用できません。アーカイブ後も配布済みリンクの帰属は維持されます。
      </p>
      <Card className="gap-4 p-5">
        <h2 className="font-semibold">新しい計測リンクを発行</h2>
        <form
          className="grid gap-4 sm:grid-cols-3"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <label className="space-y-2 text-sm">
            表示名
            <Input
              aria-label="表示名"
              required
              maxLength={100}
              value={label}
              disabled={busy || loading}
              onChange={(e) => setLabel(e.target.value)}
            />
          </label>
          <label className="space-y-2 text-sm">
            媒体
            <Input
              aria-label="媒体"
              required
              maxLength={64}
              value={medium}
              disabled={busy || loading}
              onChange={(e) => setMedium(e.target.value)}
            />
          </label>
          <label className="space-y-2 text-sm">
            施策名
            <Input
              aria-label="施策名"
              required
              maxLength={64}
              value={campaign}
              disabled={busy || loading}
              onChange={(e) => setCampaign(e.target.value)}
            />
          </label>
          <Button
            type="submit"
            className="sm:col-span-3 sm:justify-self-start"
            disabled={busy || loading || !label.trim() || !medium.trim() || !campaign.trim()}
          >
            {busy ? "処理中…" : "発行する"}
          </Button>
        </form>
      </Card>
      {created && (
        <Card className="gap-3 p-5">
          <h2>発行したリンク #{created.id}</h2>
          <Input aria-label="発行したURL" readOnly value={linkUrl(created.id)} />
          <Button variant="outline" onClick={() => void copy(created.id)}>
            発行したURLをコピー
          </Button>
        </Card>
      )}
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
      {result.loading && <p role="status">計測リンクを取得中…</p>}
      {result.error && (
        <Card className="gap-3 p-5">
          <p role="alert">{result.error}</p>
          <Button onClick={result.refresh}>再試行</Button>
        </Card>
      )}
      <Card className="p-5">
        <Table>
          <TableHeader>
            <TableRow>
              {["番号", "表示名", "媒体", "施策名", "状態", "URL", "操作"].map((v) => (
                <TableHead key={v}>{v}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((link) => (
              <TableRow key={link.id}>
                <TableCell>
                  {link.id}
                  {link.id <= 4 ? "（固定）" : ""}
                </TableCell>
                <TableCell>{link.label}</TableCell>
                <TableCell>{link.medium}</TableCell>
                <TableCell>{link.campaign}</TableCell>
                <TableCell>{link.archived ? "アーカイブ済み" : "有効"}</TableCell>
                <TableCell>
                  <Input aria-label={`リンク${link.id}のURL`} readOnly value={linkUrl(link.id)} />
                </TableCell>
                <TableCell>
                  <div className="flex gap-2">
                    <Button variant="outline" onClick={() => void copy(link.id)}>
                      コピー
                    </Button>
                    <Button
                      variant="outline"
                      disabled={busy || loading || link.id <= 4}
                      onClick={() => {
                        setEditing(link);
                        setEditLabel(link.label);
                        setError(null);
                      }}
                    >
                      表示名を変更
                    </Button>
                    <Button
                      variant="outline"
                      disabled={busy || loading}
                      onClick={() => void update(link, { archived: !link.archived })}
                    >
                      {link.archived ? "再開" : "アーカイブ"}
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {result.data && !rows.length && <p>計測リンクはありません。</p>}
        {next && (
          <Button className="mt-4" onClick={() => void more()} disabled={loading || busy}>
            {loading ? "取得中…" : "もっと見る"}
          </Button>
        )}
      </Card>
      <Dialog
        open={editing !== null}
        onOpenChange={(open, details) => {
          if (busy) details.cancel();
          else if (!open) setEditing(null);
        }}
      >
        <DialogContent aria-modal="true" showCloseButton={!busy}>
          <DialogHeader>
            <DialogTitle>表示名を変更</DialogTitle>
            <DialogDescription>番号・媒体・施策と帰属先の意味は変わりません。</DialogDescription>
          </DialogHeader>
          <label className="space-y-2">
            新しい表示名
            <Input
              aria-label="新しい表示名"
              value={editLabel}
              maxLength={100}
              disabled={busy}
              onChange={(e) => setEditLabel(e.target.value)}
            />
          </label>
          {error && <p role="alert">{error}</p>}
          <div className="flex gap-2">
            <Button
              disabled={busy || !editLabel.trim()}
              onClick={() => editing && void update(editing, { label: editLabel.trim() })}
            >
              保存
            </Button>
            <Button variant="outline" disabled={busy} onClick={() => setEditing(null)}>
              キャンセル
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
