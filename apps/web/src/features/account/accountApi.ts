import { accountProfileSchema, accountSessionSchema } from "@tetraboard/protocol";
export async function accountRequest(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, { ...init, credentials: "same-origin", cache: "no-store" });
  const body = (await response.json().catch(() => null)) as { message?: string } | null;
  if (!response.ok)
    throw new Error(body?.message ?? "通信に失敗しました。もう一度お試しください。");
  return body;
}
export async function readAccount() {
  return accountSessionSchema.parse(await accountRequest("/api/account/session")).user;
}
export async function saveProfile(setup: boolean, data: FormData) {
  return accountProfileSchema.parse(
    await accountRequest(setup ? "/api/account/setup" : "/api/account/profile", {
      method: setup ? "POST" : "PATCH",
      body: data,
    }),
  );
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
    const native = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/webp", 0.85),
    );
    const blob =
      native?.type === "image/webp"
        ? native
        : await (await import("./webpEncoder")).encodeWebp(context.getImageData(0, 0, 256, 256));
    if (blob.size === 0 || blob.size > 1024 * 1024)
      throw new Error("画像の変換に失敗しました。別の画像をお試しください。");
    return blob;
  } finally {
    bitmap.close();
  }
}
