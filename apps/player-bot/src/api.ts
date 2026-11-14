import { z } from "zod";
import { accountSessionSchema, createRoomContract } from "@tetraboard/protocol";
import { legalVersion } from "@tetraboard/protocol/privacy";
import type { Profile } from "./store";
export type Fetcher = (input: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response>;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`API ${status}: ${code}`);
  }
}
export class AccessRequired extends Error {}
export const cookieName = (origin: string) =>
  `${origin.startsWith("https:") ? "__Secure-" : ""}tetraboard-2026.session_token`;
export function cookieValue(value: string): string {
  const cookie = value.trim().replace(/^(?:__Secure-)?tetraboard-2026\.session_token=/, "");
  if (!/^[a-zA-Z0-9._~+/%=-]+$/.test(cookie)) throw Error("セッションCookieの値を確認してください");
  return cookie;
}
export class Api {
  constructor(
    readonly origin: string,
    readonly profile: Profile,
    private save: (profile: Profile) => Promise<void>,
    private fetcher: Fetcher = fetch,
  ) {}
  async request<T>(
    path: string,
    schema: z.ZodType<T>,
    options: {
      method?: string;
      body?: unknown;
      bearer?: string;
      headers?: Record<string, string>;
      signal?: AbortSignal;
      consent?: boolean;
    } = {},
  ): Promise<T> {
    if (!path.startsWith("/api/") || new URL(path, this.origin).origin !== this.origin)
      throw Error("APIの接続先が不正です");
    const headers = new Headers(options.headers);
    headers.set("Cookie", `${cookieName(this.origin)}=${cookieValue(this.profile.cookie)}`);
    headers.set("Origin", this.origin);
    if (options.consent) headers.set("X-Legal-Consent", legalVersion);
    if (options.bearer) headers.set("Authorization", `Bearer ${options.bearer}`);
    if (options.body !== undefined) headers.set("Content-Type", "application/json");
    let response: Response;
    try {
      response = await this.fetcher(new URL(path, this.origin), {
        method: options.method ?? "GET",
        headers,
        redirect: "error",
        cache: "no-store",
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: options.signal
          ? AbortSignal.any([options.signal, AbortSignal.timeout(5000)])
          : AbortSignal.timeout(5000),
      });
    } catch {
      throw new ApiError(0, "network_error");
    }
    for (const cookie of response.headers.getSetCookie()) {
      if (!cookie.startsWith(`${cookieName(this.origin)}=`)) continue;
      const value = cookie.split(";", 1)[0].slice(cookieName(this.origin).length + 1);
      if (value) {
        this.profile.cookie = cookieValue(value);
        await this.save(this.profile);
      }
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
      const known = createRoomContract.error.safeParse(body);
      const code = known.success ? known.data.error : "request_failed";
      throw new ApiError(response.status, code);
    }
    let value: unknown;
    try {
      value = response.status === 204 ? null : await response.json();
    } catch {
      throw new ApiError(0, "incompatible_response");
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new ApiError(0, "incompatible_response");
    return parsed.data;
  }
  async checkAccess(): Promise<string> {
    const { user } = await this.request("/api/account/session", accountSessionSchema);
    if (!user || user.isGuest || !user.profileCompleted || !user.username)
      throw new AccessRequired(
        "ブラウザで登録・プロフィール設定・ログイン後、Cookieを再取り込みしてください",
      );
    const identity = user.profileId ?? user.username;
    if (this.profile.identity && this.profile.identity !== identity)
      throw new AccessRequired("保存したBOTと異なるアカウントです");
    const legal = await this.request(
      "/api/account/legal",
      z.object({ accepted: z.boolean(), version: z.string() }),
    );
    if (!legal.accepted || legal.version !== legalVersion)
      throw new AccessRequired("ブラウザで現在の利用規約を確認・同意してください");
    return identity;
  }
}
