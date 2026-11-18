import type { Handler, Hono } from "hono";
import {
  listReportsContract,
  moderateReportContract,
  reportContract,
  roomCodeSchema,
  type RoomError,
} from "@tetraboard/protocol";
import { listReports } from "@tetraboard/context-community";
import { reportListStore } from "../adapters/community/reports";
import { moderateRoomMessageReport, reportRoomMessage } from "../flows/roomReports";

type RoomErrorResponse = (error: RoomError["error"]) => RoomError;

export function registerRoomReportRoutes(
  routes: Hono<{ Bindings: Env }>,
  roomError: RoomErrorResponse,
) {
  routes.on(reportContract.method, reportContract.path, reportMessage(roomError));
  routes.on(listReportsContract.method, listReportsContract.path, listRoomReports(roomError));
  routes.on(moderateReportContract.method, moderateReportContract.path, moderateReport(roomError));
}

function moderatorAuthorized(
  authorization: string | undefined,
  secret: string | undefined,
): boolean {
  if (!secret || !authorization?.startsWith("Bearer ")) return false;
  const candidate = authorization.slice(7);
  if (candidate.length !== secret.length) return false;
  let difference = 0;
  for (let index = 0; index < candidate.length; index++)
    difference |= candidate.charCodeAt(index) ^ secret.charCodeAt(index);
  return difference === 0;
}

function reportMessage(
  roomError: RoomErrorResponse,
): Handler<{ Bindings: Env }, typeof reportContract.path> {
  return async (context) => {
    const code = context.req.param("id");
    if (!roomCodeSchema.safeParse(code).success)
      return context.json(roomError("invalid_request"), 400);
    const token = context.req.header("Authorization")?.match(/^Bearer ([0-9a-f]{64})$/)?.[1];
    if (!token) return context.json(roomError("unauthorized"), 401);
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json(roomError("invalid_request"), 400);
    }
    const request = reportContract.request.safeParse(body);
    if (!request.success) return context.json(roomError("invalid_request"), 400);
    try {
      const result = await reportRoomMessage(context.env, code, token, request.data.messageId);
      if (result.status === "unauthorized") return context.json(roomError("unauthorized"), 401);
      if (result.status === "not_found") return context.json(roomError("not_found"), 404);
      if (result.status !== "created")
        return result.status === "duplicate"
          ? context.json(roomError("conflict"), 409)
          : context.json(roomError("rate_limited"), 429);
      context.header("Cache-Control", "no-store");
      return context.json(reportContract.response.parse({ id: result.id }), 201);
    } catch {
      return context.json(roomError("internal_error"), 500);
    }
  };
}

function listRoomReports(
  roomError: RoomErrorResponse,
): Handler<{ Bindings: Env }, typeof listReportsContract.path> {
  return async (context) => {
    const secret = (context.env as Env & { MODERATOR_TOKEN?: string }).MODERATOR_TOKEN;
    if (!secret) return context.json(roomError("internal_error"), 503);
    if (!moderatorAuthorized(context.req.header("Authorization"), secret))
      return context.json(roomError("unauthorized"), 401);
    const query = listReportsContract.query.safeParse(context.req.query());
    if (
      !query.success ||
      (query.data.cursor !== undefined && !/^\d{1,16}:[0-9a-f-]{36}$/.test(query.data.cursor))
    )
      return context.json(roomError("invalid_request"), 400);
    try {
      context.header("Cache-Control", "no-store");
      return context.json(
        listReportsContract.response.parse(
          await listReports(reportListStore(context.env.APP_DB), query.data.cursor),
        ),
      );
    } catch {
      return context.json(roomError("internal_error"), 500);
    }
  };
}

function moderateReport(
  roomError: RoomErrorResponse,
): Handler<{ Bindings: Env }, typeof moderateReportContract.path> {
  return async (context) => {
    const secret = (context.env as Env & { MODERATOR_TOKEN?: string }).MODERATOR_TOKEN;
    if (!secret) return context.json(roomError("internal_error"), 503);
    if (!moderatorAuthorized(context.req.header("Authorization"), secret))
      return context.json(roomError("unauthorized"), 401);
    const id = context.req.param("id");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))
      return context.json(roomError("invalid_request"), 400);
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json(roomError("invalid_request"), 400);
    }
    const request = moderateReportContract.request.safeParse(body);
    if (!request.success) return context.json(roomError("invalid_request"), 400);
    try {
      const result = await moderateRoomMessageReport(context.env, id, request.data.action);
      if (result.status === "not_found") return context.json(roomError("not_found"), 404);
      if (result.status === "conflict") return context.json(roomError("conflict"), 409);
      if (result.status === "already_resolved") return context.json(result.report);
      context.header("Cache-Control", "no-store");
      return context.json(moderateReportContract.response.parse(result.report));
    } catch {
      return context.json(roomError("internal_error"), 500);
    }
  };
}
