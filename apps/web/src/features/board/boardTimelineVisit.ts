import type { BoardAttachment, BoardPost } from "@tetraboard/protocol/board";
import type { Location } from "react-router";
import { createUuid } from "../../shared/createUuid";
import type { BoardSubmission } from "./BoardComposer";
import type { readTimeline } from "./boardApi";

type BoardTimeline = Awaited<ReturnType<typeof readTimeline>>;
type AttachmentOwner = { scope: string; id: string };
type Visit = {
  scope: string;
  entryKey: string;
  to: Pick<Location, "pathname" | "search" | "hash">;
  attachmentOwner?: AttachmentOwner;
  scrollY: number;
  data: BoardTimeline;
};

let savedDraft: TimelineDraft | undefined;
const sentDrafts = new Set<string>();
const visits = new Map<string, Visit>();

class TimelineDraft {
  private id = createUuid();
  private submission: BoardSubmission | null = null;
  attachment: BoardAttachment | null = null;

  readonly scope: string;
  private entryKey: string;
  text: string;

  constructor(scope: string, entryKey: string, text: string) {
    this.scope = scope;
    this.entryKey = entryKey;
    this.text = text;
  }

  matches(scope: string, entryKey: string, resume: boolean) {
    return (
      this.scope === scope && (resume || (entryKey !== "default" && this.entryKey === entryKey))
    );
  }

  owner(): AttachmentOwner {
    return { scope: this.scope, id: this.id };
  }

  updateAttachment(attachment: BoardAttachment | null, entryKey: string) {
    if (
      this.attachment?.matchId !== attachment?.matchId ||
      this.attachment?.position !== attachment?.position
    )
      this.submission = null;
    this.attachment = attachment;
    this.entryKey = entryKey;
  }

  changeText(text: string) {
    this.text = text;
  }

  getSubmission = () => this.submission;
  setSubmission = (value: BoardSubmission | null) => {
    this.submission = value;
  };

  finish(requestId: string) {
    if (this.submission?.id !== requestId) return;
    sentDrafts.add(this.id);
    if (savedDraft === this) savedDraft = undefined;
    this.id = createUuid();
    this.text = "";
    this.attachment = null;
    this.submission = null;
  }
}

export function openTimelineDraft(scope: string, entryKey: string, resume: boolean, text?: string) {
  if (text === undefined && savedDraft?.matches(scope, entryKey, resume)) return savedDraft;
  return new TimelineDraft(scope, entryKey, text ?? "");
}

export function rememberTimelineDraft(
  draft: TimelineDraft,
  attachment: BoardAttachment | null,
  entryKey: string,
) {
  draft.updateAttachment(attachment, entryKey);
  savedDraft = draft;
}

export function isStaleTimelineAttachment(owner: AttachmentOwner | undefined, scope: string) {
  return owner !== undefined && (owner.scope !== scope || sentDrafts.has(owner.id));
}

export function rememberTimelineVisit(
  scope: string,
  location: Location,
  data: BoardTimeline,
  attachmentOwner?: AttachmentOwner,
) {
  const { key, pathname, search, hash } = location;
  visits.delete(key);
  visits.set(key, {
    scope,
    entryKey: key,
    to: { pathname, search, hash },
    attachmentOwner,
    scrollY: window.scrollY,
    data,
  });
  // 投稿詳細を何度開いても、保持するタイムラインの数には上限を設けます。
  if (visits.size > 8) visits.delete(visits.keys().next().value!);
}

export function readTimelineVisit(scope: string, key: unknown) {
  const visit = typeof key === "string" ? visits.get(key) : undefined;
  return visit?.scope === scope ? visit : undefined;
}

export function timelineVisitState(visit: Visit) {
  return {
    restoreBoardTimeline: visit.entryKey,
    boardDraftAttachment: visit.attachmentOwner,
  };
}

export function syncTimelineVisit(
  visit: Visit | undefined,
  postNumber: number,
  post: BoardPost | null,
) {
  if (!visit) return;
  // 削除を確認した投稿は、同じ閲覧者が戻れるほかの一覧にも反映します。
  const targets = post?.status === "published" ? [visit] : visits.values();
  for (const target of targets) {
    if (target.scope !== visit.scope) continue;
    const { posts } = target.data;
    const index = posts.findIndex((item) => item.publicNumber === postNumber);
    if (index === -1) continue;
    const next = posts.slice();
    next.splice(index, 1, ...(post ? [post] : []));
    target.data = { ...target.data, posts: next };
  }
}
