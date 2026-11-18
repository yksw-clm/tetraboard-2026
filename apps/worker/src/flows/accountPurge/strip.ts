import type { RoomRuntime } from "../../durableObjects/gameRoom/runtime";
import { retiredName } from "@tetraboard/context-privacy";
import type { PurgeTargets } from "./types";
import { identityScope } from "./identityScope";

export function strip(
  runtime: RoomRuntime,
  targets: PurgeTargets,
  value: unknown,
  inherited = false,
  inheritedScope?: ReadonlySet<string>,
): unknown {
  const { accountIds, ids, names } = targets;
  if (Array.isArray(value))
    return value.map((v) => strip(runtime, targets, v, false, inheritedScope));
  if (!value || typeof value !== "object") return value;
  const row = value as Record<string, unknown>;
  const scope = identityScope(runtime, targets, row, inheritedScope);
  const matchingIds = scope ?? ids;
  const own =
    inherited ||
    accountIds.has(String(row.accountId)) ||
    (row.admission !== null &&
      typeof row.admission === "object" &&
      accountIds.has(String((row.admission as Record<string, unknown>).accountId))) ||
    matchingIds.has(String(row.id)) ||
    matchingIds.has(String(row.playerId)) ||
    matchingIds.has(String(row.senderId)) ||
    matchingIds.has(String(row.hostPlayerId));
  if (
    row.kind === "system" &&
    typeof row.text === "string" &&
    [...names].some(
      (name) => row.text === `${name}が入室しました` || row.text === `${name}が退室しました`,
    )
  )
    return {
      ...row,
      text: `${retiredName}${row.text.endsWith("が入室しました") ? "が入室しました" : "が退室しました"}`,
    };
  return stripProperties(runtime, targets, row, own, matchingIds, scope);
}

function stripProperties(
  runtime: RoomRuntime,
  targets: PurgeTargets,
  row: Record<string, unknown>,
  own: boolean,
  matchingIds: ReadonlySet<string>,
  scope: ReadonlySet<string> | undefined,
): unknown {
  const out = Object.fromEntries(
    Object.entries(row).map(([key, v]) => [
      key,
      key === "profileRatings" && v && typeof v === "object"
        ? Object.fromEntries(Object.entries(v).filter(([id]) => !matchingIds.has(id)))
        : own && ["name", "senderName", "hostName"].includes(key)
          ? retiredName
          : own &&
              [
                "accountId",
                "avatarUrl",
                "avatarKey",
                "avatarPresetId",
                "profileId",
                "hostAvatarUrl",
              ].includes(key)
            ? null
            : strip(runtime, targets, v, own && key === "appearance", scope),
    ]),
  );
  if (own && row.kind === "human") out.retired = true;
  if (own && "visitorId" in row) out.visitorId = null;
  if (own && "search" in row) delete out.search;
  return out;
}
