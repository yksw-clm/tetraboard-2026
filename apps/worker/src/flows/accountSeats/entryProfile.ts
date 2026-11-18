import { legalVersion } from "@tetraboard/protocol/privacy";
import { profileInputSchema, type RoomError } from "@tetraboard/protocol";
import { accountIdentity } from "../../accounts/auth";
import { consentStatement } from "../../adapters/privacy/consent";

export class RoomAccountError extends Error {
  constructor(
    public readonly code: RoomError["error"],
    public readonly status: 400 | 403 | 409 | 503,
  ) {
    super(code);
  }
}

export async function roomEntryProfile(request: Request, env: Env, name?: string) {
  if (request.headers.get("X-Legal-Consent") !== legalVersion)
    throw new RoomAccountError("consent_required", 403);
  const user = await accountIdentity(request, env);
  if (user) {
    if (request.headers.get("Origin") !== env.APP_ORIGIN)
      throw new RoomAccountError("unauthorized", 403);
    if (
      !user.profileCompleted ||
      !(user.isAnonymous ? user.guestNameCustomized : profileInputSchema.safeParse(user).success)
    )
      throw new RoomAccountError("profile_required", 403);
    await consentStatement(env.APP_DB, user.id).run();
    return { name: user.name, user };
  }
  if (
    /(?:^|;\s*)(?:__Secure-)?tetraboard-2026\.session_token=/.test(
      request.headers.get("Cookie") ?? "",
    )
  )
    throw new RoomAccountError("unauthorized", 403);
  if (!name) throw new RoomAccountError("invalid_request", 400);
  return { name, user: null };
}
