import { getPublicMatchContract, type RoomMode } from "@tetraboard/protocol";
import type { BoardAttachment } from "@tetraboard/protocol/board";
import { gameCatalog, type GameId } from "@tetraboard/protocol/games";
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { AppButton } from "../../shared/ui/AppButton";
import { AppDialog } from "../../shared/ui/AppDialog";
import { AppTextField } from "../../shared/ui/AppTextField";
import { gameThemes } from "../../shared/ui/appTheme";
import { useMatchHistory } from "../account/useMatchHistory";
import { formatMatchDate } from "../matches/matchDatePresentation";
import { initialReplayIndex } from "../room/initialReplayIndex";
import { BoardRequestError } from "./boardApi";
import type { loadAttachmentPreview } from "./boardAttachmentFrames";
import { useBoardMedia } from "./boardMedia";

type Target = { matchId: string; position: string | number | null };
type Preview = Awaited<ReturnType<typeof loadAttachmentPreview>>;
type Result =
  | { target: Target; error: string }
  | { target: Target; preview: Preview; position: number };

const invalidUrl = "このサイトの公開棋譜のURLを入力してください。";

function readPublicMatchUrl(value: string): Target | null {
  try {
    const url = new URL(value);
    if (url.origin !== window.location.origin || url.username || url.password) return null;
    const path = /^\/matches\/([^/]+)$/.exec(url.pathname);
    const result = getPublicMatchContract.params.safeParse({ matchId: path?.[1] });
    return result.success
      ? { matchId: result.data.matchId, position: url.searchParams.get("position") }
      : null;
  } catch {
    return null;
  }
}

function RecentMatches({
  game,
  mode,
  onSelect,
}: {
  game: GameId;
  mode: RoomMode;
  onSelect: (target: Target) => void;
}) {
  const { page, retry } = useMatchHistory(game, mode);
  if (page.error)
    return (
      <div className="grid justify-items-start gap-2">
        <p role="alert" className="m-0 text-sm text-danger">
          {page.error}
        </p>
        <AppButton appearance="secondary" isPending={page.loading} onPress={() => void retry()}>
          再試行
        </AppButton>
      </div>
    );
  if (!page.loaded || page.loading)
    return (
      <p role="status" className="m-0 text-sm text-muted">
        対局履歴を読み込んでいます…
      </p>
    );
  if (!page.matches.length)
    return <p className="m-0 text-sm text-muted">まだ対局履歴がありません。</p>;
  return (
    <ul className="m-0 grid list-none gap-2 p-0">
      {page.matches.map((match) => (
        <li key={match.id}>
          <AppButton
            appearance="secondary"
            className="grid min-h-11 w-full justify-items-start gap-1 whitespace-normal text-left"
            onPress={() => onSelect({ matchId: match.id, position: null })}
          >
            <span className="wrap-anywhere">
              {match.participants.map(({ name }) => name).join("・")}
            </span>
            <span className="text-xs font-normal text-muted">
              <time dateTime={new Date(match.startedAtMs).toISOString()}>
                {formatMatchDate(match.startedAtMs)}
              </time>
              {"・"}
              {match.participants.some(({ kind }) => kind === "cpu") ? "CPUあり" : "対人戦"}
              {match.moveCount !== undefined && `・${match.moveCount}手`}
            </span>
          </AppButton>
        </li>
      ))}
    </ul>
  );
}

export function BoardAttachmentPicker({
  game,
  attachment,
  hasHistory,
  onClose,
  onConfirm,
}: {
  game: GameId;
  attachment: BoardAttachment | null;
  hasHistory: boolean;
  onClose: () => void;
  onConfirm: (attachment: BoardAttachment) => void;
}) {
  const media = useBoardMedia();
  const [source, setSource] = useState<"history" | "url">(hasHistory ? "history" : "url");
  const [mode, setMode] = useState<RoomMode>("singles");
  const [url, setUrl] = useState("");
  const [urlError, setUrlError] = useState(false);
  const [target, setTarget] = useState<Target | null>(attachment);
  const [result, setResult] = useState<Result | null>(null);
  const sourceControls = useRef<HTMLDivElement>(null);
  const previewTitle = useRef<HTMLHeadingElement>(null);
  const current = result?.target === target ? result : null;
  const selected = current && "preview" in current ? current : null;
  const frame = selected?.preview.frameAt(selected.position);

  useLayoutEffect(() => {
    (target ? previewTitle.current : sourceControls.current)?.focus({ preventScroll: true });
  }, [target]);

  useEffect(() => {
    if (!target) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]);
    const fail = (error: string) => {
      if (!controller.signal.aborted) setResult({ target, error });
    };
    async function load(target: Target) {
      try {
        const { readBoardMatch } = await import("./boardMediaRequests");
        signal.throwIfAborted();
        const match = await readBoardMatch(target.matchId, signal);
        signal.throwIfAborted();
        if (match.id !== target.matchId) {
          fail("指定された公開棋譜を取得できませんでした。");
          return;
        }
        if (match.settings.game !== game) {
          fail("この掲示板と同じゲームの棋譜を選んでください。");
          return;
        }
        const { loadAttachmentPreview } = await import("./boardAttachmentFrames");
        signal.throwIfAborted();
        const preview = await loadAttachmentPreview(match, signal);
        signal.throwIfAborted();
        const position =
          typeof target.position === "number"
            ? target.position
            : initialReplayIndex(target.position, preview.positions.length);
        if (!preview.frameAt(position)) {
          fail("棋譜の局面が見つかりません。");
          return;
        }
        setResult({ target, preview, position });
      } catch (error) {
        fail(
          error instanceof BoardRequestError && error.status === 404
            ? "公開棋譜が見つかりません。"
            : "棋譜を読み込めませんでした。",
        );
      }
    }
    void load(target);
    return () => controller.abort();
  }, [game, target]);

  function loadUrl(event: FormEvent) {
    event.preventDefault();
    const next = readPublicMatchUrl(url.trim());
    setUrlError(!next);
    if (next) setTarget(next);
  }

  return (
    <AppDialog
      title="棋譜を添付"
      theme={gameThemes[game]}
      scrollBody
      onClose={onClose}
      footer={
        <div className="flex w-full flex-wrap items-center justify-end gap-2">
          {target && (
            <AppButton appearance="quiet" className="mr-auto" onPress={() => setTarget(null)}>
              戻る
            </AppButton>
          )}
          <AppButton appearance="secondary" onPress={onClose}>
            キャンセル
          </AppButton>
          <AppButton
            isDisabled={!frame}
            onPress={() => {
              if (!selected || !frame) return;
              const { target, position, preview } = selected;
              media.attachment.remember(target.matchId, preview);
              onConfirm({ matchId: target.matchId, position });
            }}
          >
            この局面を添付
          </AppButton>
        </div>
      }
    >
      {target ? (
        <div className="m-1 grid min-w-0 gap-3">
          <h3 ref={previewTitle} tabIndex={-1} className="m-0 text-base font-bold">
            添付する局面
          </h3>
          {!current && (
            <p role="status" className="m-0 text-sm text-muted">
              棋譜を読み込んでいます…
            </p>
          )}
          {current && "error" in current && (
            <p role="alert" className="m-0 text-sm text-danger">
              {current.error}
            </p>
          )}
          {selected && frame && (
            <div className="grid min-w-0 items-start gap-3 sm:grid-cols-2">
              <div className="w-full max-w-56 justify-self-center">
                <selected.preview.Board {...frame} />
              </div>
              <label className="grid min-w-0 gap-2 text-sm font-semibold">
                局面
                <select
                  className="min-h-11 w-full min-w-0 rounded-control border border-solid border-input bg-surface-input px-2 text-base text-ink focus-visible:outline-[3px] focus-visible:outline-focus"
                  value={selected.position}
                  onChange={(event) => {
                    setResult({ ...selected, position: Number(event.currentTarget.value) });
                  }}
                >
                  {selected.preview.positions.map(({ label, accessibleLabel }, position) => (
                    <option key={position} value={position} aria-label={accessibleLabel}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
        </div>
      ) : (
        <div className="m-1 grid min-w-0 gap-3">
          <div
            ref={sourceControls}
            tabIndex={-1}
            role="group"
            aria-label="棋譜の選び方"
            className="flex flex-wrap gap-2"
          >
            <AppButton
              appearance={source === "history" ? "primary" : "secondary"}
              aria-pressed={source === "history"}
              isDisabled={!hasHistory}
              onPress={() => setSource("history")}
            >
              自分の対局
            </AppButton>
            <AppButton
              appearance={source === "url" ? "primary" : "secondary"}
              aria-pressed={source === "url"}
              onPress={() => setSource("url")}
            >
              URLを貼る
            </AppButton>
          </div>
          {source === "history" && hasHistory && (
            <>
              {gameCatalog[game].hasModes && (
                <div className="flex flex-wrap gap-2" role="group" aria-label="対局モード">
                  {(["singles", "doubles"] as const).map((item) => (
                    <AppButton
                      key={item}
                      size="compact"
                      appearance={mode === item ? "primary" : "secondary"}
                      aria-pressed={mode === item}
                      onPress={() => setMode(item)}
                    >
                      {item === "singles" ? "シングルス" : "ダブルス"}
                    </AppButton>
                  ))}
                </div>
              )}
              <RecentMatches game={game} mode={mode} onSelect={setTarget} />
            </>
          )}
          {source === "url" && (
            <form className="grid justify-items-end gap-2" noValidate onSubmit={loadUrl}>
              <AppTextField
                type="url"
                className="w-full"
                value={url}
                isInvalid={urlError}
                onChange={(next) => {
                  setUrl(next);
                  setUrlError(false);
                }}
              >
                <AppTextField.Label>公開棋譜のURL</AppTextField.Label>
                <AppTextField.Input placeholder={`${window.location.origin}/matches/…`} />
                {urlError && (
                  <AppTextField.Error>
                    <span role="alert">{invalidUrl}</span>
                  </AppTextField.Error>
                )}
              </AppTextField>
              <AppButton type="submit" appearance="secondary">
                読み込む
              </AppButton>
            </form>
          )}
        </div>
      )}
    </AppDialog>
  );
}
