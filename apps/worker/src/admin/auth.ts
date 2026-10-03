import { accountIdentity, type AuthEnv } from "../accounts/auth";
export type AdminEnv = AuthEnv & { ADMIN_ACCOUNT_ID?: string };
export async function adminIdentity(request: Request, env: AdminEnv) {
  if (!env.ADMIN_ACCOUNT_ID) return { status: 503 as const, message: "管理者の設定がありません。" };
  try {
    const user = await accountIdentity(request, env);
    if (!user) return { status: 401 as const, message: "ログインしてください。" };
    if (user.id !== env.ADMIN_ACCOUNT_ID)
      return { status: 403 as const, message: "管理画面を利用する権限がありません。" };
    return { status: 200 as const, user };
  } catch {
    return {
      status: 503 as const,
      message: "ログイン状態を確認できません。時間をおいて再試行してください。",
    };
  }
}
