import { feedbackReceiptSchema } from "@tetraboard/protocol";
import type { FeedbackInput } from "@tetraboard/protocol";
export async function sendFeedback(input: FeedbackInput, attachment: Blob | null) {
  const data = new FormData();
  data.set("input", JSON.stringify(input));
  if (attachment) data.set("attachment", attachment, "screenshot.webp");
  const response = await fetch("/api/feedback", {
    method: "POST",
    body: data,
    credentials: "same-origin",
    cache: "no-store",
  });
  const body = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(
      body?.message ?? "送信できませんでした。入力を残しています。もう一度お試しください。",
    );
  return feedbackReceiptSchema.parse(body).id;
}
export async function convertFeedbackImage(file: File): Promise<Blob> {
  if (
    !["image/jpeg", "image/png", "image/webp"].includes(file.type) ||
    file.size === 0 ||
    file.size > 5 * 1024 * 1024
  )
    throw new Error("5MB以下のJPEG・PNG・WebP画像を選んでください。");
  const bitmap = await createImageBitmap(file);
  try {
    if (bitmap.width * bitmap.height > 40_000_000)
      throw new Error("画像が大きすぎます。縮小してから選んでください。");
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("このブラウザでは画像を変換できません。");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    // Chromiumのcanvas.toBlob(WebP)はICCメタデータを付けるため、
    // 画素だけを共通エンコーダーへ渡し、全ブラウザでメタデータを除きます。
    const blob = await (
      await import("../../shared/images/webpEncoder")
    ).encodeWebp(context.getImageData(0, 0, canvas.width, canvas.height));
    if (!blob.size || blob.size > 1024 * 1024)
      throw new Error("変換後の画像が1MBを超えています。小さい画像を選んでください。");
    return blob;
  } finally {
    bitmap.close();
  }
}
