import { readCurrentProfiles as readProfiles } from "@tetraboard/context-account";
import { D1AccountProfiles } from "../adapters/account/profiles";
import { profilePolicy } from "../adapters/account/profilePolicy";
export type { CurrentProfile } from "@tetraboard/context-account";
export const readCurrentProfiles = (db: D1Database, ids: readonly string[]) =>
  readProfiles(new D1AccountProfiles(db), profilePolicy, ids);
