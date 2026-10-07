import { useState, useRef, useEffect } from "react";
import {
  feedbackInputSchema,
  type FeedbackTechnical,
  type FeedbackInput,
} from "@tetraboard/protocol";
import { sendFeedback, convertFeedbackImage } from "./feedbackApi";
export type FeedbackContext = Pick<FeedbackTechnical, "page" | "game" | "room">;
export function useFeedback(context: FeedbackContext, accountRequired: boolean) {
  const [draft, setDraft] = useState({
    kind: "" as FeedbackInput["kind"] | "",
    game: context.game,
    body: "",
    expectation: "",
    steps: "",
    technical: true,
  });
  const [attachment, setAttachment] = useState<Blob | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const submissionId = useRef(crypto.randomUUID() as string);
  const locked = useRef(false);
  const frozenInput = useRef<FeedbackInput | null>(null);
  const alive = useRef(true);
  function currentTechnical() {
    return {
      page: context.page,
      game: draft.game,
      browser: navigator.userAgent.slice(0, 512),
      width: window.innerWidth,
      height: window.innerHeight,
      build: import.meta.env.VITE_APP_REVISION ?? "development",
      ...(context.room ? { room: context.room } : {}),
    };
  }
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview);
    },
    [preview],
  );
  function changed() {
    submissionId.current = crypto.randomUUID();
    frozenInput.current = null;
    setMessage(null);
  }
  function update<K extends keyof typeof draft>(key: K, value: (typeof draft)[K]) {
    if (locked.current) return;
    changed();
    setDraft((old) => ({ ...old, [key]: value }));
  }
  async function selectImage(file: File) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const blob = await convertFeedbackImage(file);
      if (!alive.current) return;
      changed();
      setAttachment(blob);
      setPreview(URL.createObjectURL(blob));
    } catch (err) {
      if (alive.current)
        setMessage(err instanceof Error ? err.message : "画像を読み込めませんでした。");
    } finally {
      locked.current = false;
      if (alive.current) setBusy(false);
    }
  }
  function removeImage() {
    if (!locked.current) {
      changed();
      setAttachment(null);
      setPreview(null);
    }
  }
  async function submit() {
    if (locked.current) return;
    const input = feedbackInputSchema.safeParse(
      frozenInput.current ?? {
        submissionId: submissionId.current,
        accountRequired,
        kind: draft.kind,
        game: draft.game,
        body: draft.body,
        expectation: draft.expectation,
        steps: draft.kind === "bug" ? draft.steps : "",
        technical: draft.kind === "bug" && draft.technical ? currentTechnical() : null,
      },
    );
    if (!input.success) {
      setMessage(
        "種別を選び、内容を1〜2,000文字、期待・目的を500文字、再現手順を1,000文字以内で入力してください。",
      );
      return;
    }
    frozenInput.current = input.data;
    locked.current = true;
    setBusy(true);
    setSubmitting(true);
    setMessage(null);
    try {
      const id = await sendFeedback(input.data, attachment);
      if (!alive.current) return;
      setReceipt(id);
      setDraft({
        kind: "",
        game: context.game,
        body: "",
        expectation: "",
        steps: "",
        technical: true,
      });
      setAttachment(null);
      setPreview(null);
      frozenInput.current = null;
    } catch (err) {
      if (alive.current)
        setMessage(
          err instanceof Error ? err.message : "送信できませんでした。入力を残しています。",
        );
    } finally {
      locked.current = false;
      if (alive.current) {
        setBusy(false);
        setSubmitting(false);
      }
    }
  }
  function reset() {
    changed();
    setReceipt(null);
  }
  return {
    draft,
    technicalInfo: frozenInput.current?.technical ?? currentTechnical(),
    update,
    attachment,
    preview,
    busy,
    submitting,
    message,
    receipt,
    selectImage,
    removeImage,
    submit,
    reset,
  };
}
