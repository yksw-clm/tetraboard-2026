import { Dropdown } from "@heroui/react";
import type { BoardPublishedPost } from "@tetraboard/protocol/board";
import { boardPostPath } from "@tetraboard/protocol/board-presentation";
import { useState } from "react";
import { AppIcon } from "../../shared/ui/AppIcon";
import { BoardDeleteDialog, type BoardDeleteActions } from "./BoardDeleteDialog";

const itemClass =
  "flex min-h-11 cursor-pointer items-center gap-3 rounded-control px-3 text-sm data-[focused=true]:bg-surface-hover";

export function BoardPostMenu({
  post,
  ...actions
}: BoardDeleteActions & { post: BoardPublishedPost }) {
  const [confirm, setConfirm] = useState(false);
  const [copyResult, setCopyResult] = useState<"success" | "failure" | null>(null);

  async function copyLink() {
    setCopyResult(null);
    try {
      const url = new URL(boardPostPath(post.publicNumber), window.location.origin);
      await navigator.clipboard.writeText(url.href);
      setCopyResult("success");
    } catch {
      setCopyResult("failure");
    }
  }

  return (
    <>
      <Dropdown>
        <Dropdown.Trigger
          aria-label="投稿メニュー"
          className="relative z-10 ml-auto grid size-11 min-h-11 min-w-11 shrink-0 cursor-pointer place-items-center rounded-control border-0 bg-transparent p-0 text-muted data-[hovered=true]:bg-surface-muted data-[pressed=true]:bg-surface-muted focus-visible:outline-3 focus-visible:outline-focus focus-visible:outline-offset-2"
        >
          <AppIcon name="ellipsis" />
        </Dropdown.Trigger>
        <Dropdown.Popover
          placement="bottom end"
          className="app-theme w-48 rounded-panel border border-solid border-line bg-white p-1.5 shadow-dialog"
        >
          <Dropdown.Menu
            aria-label="投稿メニュー"
            onAction={(key) => {
              if (key === "copy") void copyLink();
              if (key === "delete" && post.own && !actions.busy) setConfirm(true);
            }}
          >
            <Dropdown.Item id="copy" textValue="リンクをコピー" className={itemClass}>
              <AppIcon name="copy" />
              リンクをコピー
            </Dropdown.Item>
            {post.own && (
              <Dropdown.Item
                id="delete"
                textValue="削除"
                isDisabled={actions.busy}
                className={`${itemClass} text-danger`}
              >
                削除
              </Dropdown.Item>
            )}
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>
      <p
        aria-live="polite"
        aria-atomic="true"
        className={copyResult ? "basis-full text-right text-sm" : "sr-only"}
      >
        {copyResult === "success" && "リンクをコピーしました。"}
        {copyResult === "failure" && (
          <span className="text-danger">リンクをコピーできませんでした。</span>
        )}
      </p>
      {confirm && post.own && (
        <BoardDeleteDialog
          {...actions}
          id={post.id}
          game={post.gameId}
          onClose={() => setConfirm(false)}
        />
      )}
    </>
  );
}
