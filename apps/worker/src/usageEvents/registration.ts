import type { RegistrationAnalyticsInput } from "@tetraboard/protocol";
import { createAuth, type AuthEnv, type StoredProfile } from "../accounts/auth";
import { responseCookies } from "../privacy/deletion";
import { browserIdFromRequest } from "./browserId";
import type { UsageEvent } from "./events";
import { createUsageEventWriter } from "./writer";

type RegistrationEvent = Extract<UsageEvent, { name: "registration" }>;

export function registrationUsage(
  env: Pick<Env, "USAGE_EVENTS">,
  input?: RegistrationAnalyticsInput,
  browserId?: string | null,
) {
  const writer = createUsageEventWriter(env.USAGE_EVENTS);
  let event: RegistrationEvent = {
    name: "registration",
    stage: "entry",
    flowId: input?.id,
    entry: input?.entry ?? "unknown",
    game: input?.game,
    browserId,
    isTest: false,
  };
  return {
    identify(flow: RegistrationAnalyticsInput, user: StoredProfile | null) {
      event = {
        ...event,
        flowId: flow.id,
        entry: flow.entry,
        game: flow.game,
        accountId: user?.id,
        isTest: Boolean(user?.isTestUser),
      };
    },
    write(stage: RegistrationEvent["stage"]) {
      writer.write({ ...event, stage });
    },
  };
}

async function completionEvent(env: Env, request: Request, accountId: string) {
  const user = await env.APP_DB.prepare(`SELECT isTestUser FROM user WHERE id=?
    AND COALESCE(isAnonymous,0)=0 AND NOT EXISTS(SELECT 1 FROM deleted_accounts WHERE id=user.id)`)
    .bind(accountId)
    .first<{ isTestUser: number | null }>();
  if (!user) return null;
  return {
    name: "registration" as const,
    flowId: null,
    entry: "unknown" as const,
    game: null,
    browserId: browserIdFromRequest(request),
    accountId,
    isTest: Boolean(user.isTestUser),
  };
}

export async function writeRegistrationCompletionUsage(
  env: AuthEnv,
  request: Request,
  response: Response,
  newAccount: boolean,
) {
  if (!env.USAGE_EVENTS) return;
  try {
    if (!/\/callback\/(google|discord)$/.test(new URL(request.url).pathname)) return;
    const session = await createAuth(env).api.getSession({
      headers: responseCookies(request, response),
    });
    if (!session) return;
    const event = await completionEvent(env, request, session.user.id);
    if (!event) return;
    const writer = createUsageEventWriter(env.USAGE_EVENTS);
    writer.write({ ...event, stage: "oauth_success" });
    writer.write({ ...event, stage: newAccount ? "registered" : "existing_login" });
  } catch {
    console.warn("Usage registration context read failed");
  }
}

export async function writeProfileCompletionUsage(env: Env, accountId: string, request: Request) {
  if (!env.USAGE_EVENTS) return;
  try {
    const event = await completionEvent(env, request, accountId);
    if (!event) return;
    createUsageEventWriter(env.USAGE_EVENTS).write({
      ...event,
      stage: "profile_complete",
    });
  } catch {
    console.warn("Usage registration context read failed");
  }
}
