import type { RegistrationAnalyticsInput } from "@tetraboard/protocol";
import { analyticsRetentionMs } from "@tetraboard/protocol/privacy";
import type { StoredProfile } from "../accounts/auth";
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

type Flow = {
  id: string;
  entry: RegistrationEvent["entry"];
  game: string;
  visitor_id: string | null;
  is_test: number;
  is_new_registration: number | null;
};

export async function writeRegistrationCompletionUsage(
  env: Env,
  flowId: string,
  accountId: string,
  newAccount: boolean,
  now: number,
) {
  if (!env.USAGE_EVENTS) return;
  try {
    const flow = await env.APP_DB.prepare(`SELECT f.id,f.entry,f.game,f.visitor_id,
      MAX(f.is_test,COALESCE(u.isTestUser,0)) AS is_test,
      COALESCE(f.is_new_registration,?) AS is_new_registration
      FROM analytics_registration_flows f JOIN user u ON u.id=?
      WHERE f.id=? AND f.created_at_ms>? AND (f.target_account_id IS NULL OR f.target_account_id=?)
      AND COALESCE(u.isAnonymous,0)=0 AND NOT EXISTS(SELECT 1 FROM deleted_accounts WHERE id=u.id)`)
      .bind(Number(newAccount), accountId, flowId, now - analyticsRetentionMs, accountId)
      .first<Flow>();
    if (!flow) return;
    const writer = createUsageEventWriter(env.USAGE_EVENTS);
    const event = {
      name: "registration" as const,
      flowId: flow.id,
      entry: flow.entry,
      game: flow.game === "all" ? null : flow.game,
      browserId: flow.visitor_id,
      accountId,
      isTest: Boolean(flow.is_test),
    };
    writer.write({ ...event, stage: "oauth_success" });
    writer.write({ ...event, stage: flow.is_new_registration ? "registered" : "existing_login" });
  } catch {
    console.warn("Usage registration context read failed");
  }
}

export async function writeProfileCompletionUsage(env: Env, accountId: string, now: number) {
  if (!env.USAGE_EVENTS) return;
  try {
    const flow = await env.APP_DB.prepare(`SELECT f.id,f.entry,f.game,f.visitor_id,f.is_test
      FROM analytics_registration_flows f
      WHERE f.target_account_id=? AND f.profile_required=1 AND f.created_at_ms>?
      AND EXISTS(SELECT 1 FROM analytics_registration_events e WHERE e.flow_id=f.id AND e.stage='oauth_success')
      AND NOT EXISTS(SELECT 1 FROM deleted_accounts WHERE id=?)
      ORDER BY f.created_at_ms DESC,f.id LIMIT 1`)
      .bind(accountId, now - analyticsRetentionMs, accountId)
      .first<Flow>();
    if (!flow) return;
    createUsageEventWriter(env.USAGE_EVENTS).write({
      name: "registration",
      flowId: flow.id,
      entry: flow.entry,
      game: flow.game === "all" ? null : flow.game,
      browserId: flow.visitor_id,
      accountId,
      isTest: Boolean(flow.is_test),
      stage: "profile_complete",
    });
  } catch {
    console.warn("Usage registration context read failed");
  }
}
