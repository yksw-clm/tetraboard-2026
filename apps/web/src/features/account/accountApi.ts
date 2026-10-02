import { createAuthClient } from "better-auth/react";
import { accountPaths, accountSessionSchema } from "@tetraboard/protocol";
export const authClient = createAuthClient();
export async function accountRequest(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, { ...init, cache: "no-store" });
  if (response.status === 204) return null;
  const body = (await response.json()) as { message?: string };
  if (!response.ok)
    throw new Error(body.message ?? "読み込みに失敗しました。もう一度お試しください。");
  return body;
}
export async function readAccount() {
  return accountSessionSchema.parse(await accountRequest(accountPaths.session)).user;
}
export async function convertAvatar(file: File): Promise<Blob> {
  if (
    !["image/jpeg", "image/png", "image/webp"].includes(file.type) ||
    file.size > 5 * 1024 * 1024 ||
    file.size === 0
  )
    throw new Error("5MB以下のJPEG・PNG・WebP画像を選んでください。");
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 256;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("このブラウザでは画像を変換できません。");
    const size = Math.min(bitmap.width, bitmap.height);
    context.drawImage(
      bitmap,
      (bitmap.width - size) / 2,
      (bitmap.height - size) / 2,
      size,
      size,
      0,
      0,
      256,
      256,
    );
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (blob) => {
          if (!blob || blob.type !== "image/webp" || blob.size > 1024 * 1024)
            reject(new Error("画像の変換に失敗しました。別の画像をお試しください。"));
          else resolve(blob);
        },
        "image/webp",
        0.85,
      ),
    );
  } finally {
    bitmap.close();
  }
}
