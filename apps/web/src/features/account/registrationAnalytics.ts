import {
  registrationAnalyticsInputSchema,
  type RegistrationAnalyticsInput,
  type RegistrationEntry,
} from "@tetraboard/protocol";
import type { GameId } from "@tetraboard/protocol/games";
import { createUuid } from "../../shared/createUuid";
const storageKey = "tetraboard:registration-analytics";
const lifetimeMs = 1800000;
function saved(): RegistrationAnalyticsInput | null {
  try {
    const raw = JSON.parse(sessionStorage.getItem(storageKey) ?? "null");
    if (
      !raw ||
      typeof raw.createdAtMs !== "number" ||
      Date.now() - raw.createdAtMs >= lifetimeMs ||
      raw.createdAtMs > Date.now()
    )
      return null;
    const input = registrationAnalyticsInputSchema.safeParse(raw.context);
    return input.success ? input.data : null;
  } catch {
    return null;
  }
}
export function sendRegistrationEntry(context: RegistrationAnalyticsInput) {
  // 入口の送信失敗で遷移を遅らせず、OAuth開始時にも同じ手続きIDを渡します。
  void fetch("/api/analytics/registration", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(context),
    keepalive: true,
  }).catch(() => undefined);
}
export function beginRegistrationEntry(
  entry: RegistrationEntry,
  game: GameId | null = null,
  send = true,
) {
  const context = { id: createUuid(), entry, game };
  try {
    sessionStorage.setItem(storageKey, JSON.stringify({ context, createdAtMs: Date.now() }));
  } catch {
    /* 保存不可でも認証は続けます。 */
  }
  if (send) sendRegistrationEntry(context);
  return context;
}
export function registrationContext(
  entry: RegistrationEntry = "login-page",
  game: GameId | null = null,
) {
  const current = saved();
  if (current && (entry === "login-page" || (current.entry === entry && current.game === game)))
    return current;
  return beginRegistrationEntry(entry, game, false);
}
