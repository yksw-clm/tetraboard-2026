import { feedbackInputSchema } from "@tetraboard/protocol";
import { validFeedbackImage } from "@tetraboard/context-community";
import { readLimitedBody } from "./readLimitedBody";

export const validFeedbackId = (id: string) =>
  /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/.test(id);

export async function readFeedbackForm(request: Request, url: string) {
  const bytes = await readLimitedBody(request, 1024 * 1024 + 64 * 1024);
  if (!bytes) return { status: 413, message: "添付画像は変換後1MB以下にしてください。" } as const;
  let data: FormData;
  try {
    data = await new Request(url, {
      method: "POST",
      headers: request.headers,
      body: bytes,
    }).formData();
  } catch {
    return { status: 400, message: "送信形式が正しくありません。" } as const;
  }
  if (
    [...data.keys()].some((key) => !["input", "attachment"].includes(key)) ||
    data.getAll("input").length !== 1 ||
    data.getAll("attachment").length > 1
  )
    return { status: 400, message: "送信形式が正しくありません。" } as const;
  let raw: unknown;
  try {
    raw = JSON.parse(String(data.get("input")));
  } catch {
    return { status: 400, message: "入力内容を確認してください。" } as const;
  }
  const input = feedbackInputSchema.safeParse(raw);
  if (!input.success)
    return { status: 400, message: "種別・内容・文字数を確認してください。" } as const;
  const file = data.get("attachment");
  let image: Uint8Array | null = null;
  if (file !== null) {
    if (!(file instanceof File) || file.type !== "image/webp")
      return { status: 415, message: "添付画像の形式が正しくありません。" } as const;
    image = new Uint8Array(await file.arrayBuffer());
    if (!validFeedbackImage(image))
      return { status: 400, message: "添付画像の形式・容量・寸法を確認してください。" } as const;
  }
  return { status: 200, input: input.data, image } as const;
}
