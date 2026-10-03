import { accountIdentity, type AuthEnv } from "../accounts/auth";
export type AdminEnv = AuthEnv & { ADMIN_ACCOUNT_ID?: string; ADMIN_ACCOUNT_IDS?: string };
export function adminAccountIds(env: AdminEnv): string[] | null {
  if (env.ADMIN_ACCOUNT_IDS !== undefined) {
    try {
      const ids: unknown = JSON.parse(env.ADMIN_ACCOUNT_IDS);
      if (
        !Array.isArray(ids) ||
        !ids.length ||
        ids.length > 32 ||
        !ids.every(
          (id) => typeof id === "string" && id.length > 0 && id.length <= 200 && id.trim() === id,
        )
      )
        return null;
      return [...new Set(ids)];
    } catch {
      return null;
    }
  }
  const id = env.ADMIN_ACCOUNT_ID?.trim();
  return id ? [id] : null;
}
export async function adminIdentity(request: Request, env: AdminEnv) {
  const ids = adminAccountIds(env);
  if (!ids) return { status: 503 as const, message: "管理者の設定がありません。" };
  try {
    const user = await accountIdentity(request, env);
    if (!user) return { status: 401 as const, message: "ログインしてください。" };
    if (!ids.includes(user.id))
      return { status: 403 as const, message: "管理画面を利用する権限がありません。" };
    return { status: 200 as const, user };
  } catch {
    return {
      status: 503 as const,
      message: "ログイン状態を確認できません。時間をおいて再試行してください。",
    };
  }
}
