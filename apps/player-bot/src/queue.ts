import { z } from "zod";
import {
  matchmakingStateSchema,
  tournamentParticipationSchema,
  tournamentControllerResponseSchema,
  tournamentDetailSchema,
  getTournamentSettings,
  getRoomMembershipContract,
} from "@tetraboard/protocol";
import { Api, ApiError } from "./api";
import type { BotState, Seat } from "./store";
import { sleep, type Log, type RunConfig } from "./config";
import { StopControl } from "./session";

const ok = z.object({ ok: z.literal(true) });
export class Queue {
  constructor(
    private api: Api,
    private config: RunConfig,
    private state: BotState,
    private save: () => Promise<void>,
    private stop: StopControl,
    private draining: () => boolean,
    private log: Log,
    private pause = () => sleep(1000),
  ) {}
  private ratedPath(action = "") {
    return `/api/matchmaking/${this.config.game}${action ? `/${action}` : ""}?rated=1&previousMatch=1&controllerId=${this.state.controllerId}`;
  }
  private tournamentPath(action = "") {
    if (this.config.target.type !== "tournament") throw Error("大会が指定されていません");
    return `/api/tournaments/${this.config.target.id}${action ? `/${action}` : ""}`;
  }
  private async rememberRated(value: z.infer<typeof matchmakingStateSchema>): Promise<Seat | null> {
    if (value.operationId && value.controllerId !== this.state.controllerId)
      throw Error("別の操作元がこのBOTを使用しています");
    if (value.operationId) this.state.operationId = value.operationId;
    if (value.version !== undefined) this.state.version = value.version;
    const a = value.assignment;
    if (a)
      this.state.seat = {
        roomId: a.roomId,
        instanceId: a.instanceId,
        token: a.membership.token,
        playerId: a.membership.playerId,
      };
    await this.save();
    return a ? this.state.seat! : null;
  }
  async next(): Promise<Seat | null> {
    let heartbeatAt = 0;
    let lastStatus = "";
    while (this.stop.mode !== "force") {
      if (this.config.target.type === "rated") {
        const value = await this.api.request(this.ratedPath(), matchmakingStateSchema);
        if (value.status !== lastStatus) {
          this.log("queue", { status: value.status, type: "rated" });
          lastStatus = value.status;
        }
        const seat = await this.rememberRated(value);
        if (seat) return seat;
        if (value.status === "matched" || value.status === "playing") {
          if (value.controllerId !== this.state.controllerId)
            throw Error("レート戦の操作元が変わりました");
        } else if (value.status === "waiting") {
          if (this.draining()) {
            const result = await this.api.request(
              this.ratedPath("cancel"),
              matchmakingStateSchema,
              { method: "POST", body: this.ratedControl(), consent: true },
            );
            const assigned = await this.rememberRated(result);
            if (assigned) return assigned;
            if (result.status === "idle") {
              await this.clear();
              return null;
            }
          } else if (performance.now() >= heartbeatAt) {
            await this.rememberRated(
              await this.api.request(this.ratedPath("heartbeat"), matchmakingStateSchema, {
                method: "POST",
                body: this.ratedControl(),
                consent: true,
              }),
            );
            heartbeatAt = performance.now() + 9000;
            if (this.state.seat) return this.state.seat;
          }
        } else {
          if (this.draining()) {
            await this.clear();
            return null;
          }
          if (!value.previousMatch && value.enabled !== false) {
            await this.api.checkAccess();
            if (this.draining()) continue;
            if (this.state.version !== undefined) await this.clear();
            this.state.operationId ??= crypto.randomUUID();
            await this.save();
            if (this.draining()) continue;
            await this.rememberRated(
              await this.api.request(this.ratedPath("join"), matchmakingStateSchema, {
                method: "POST",
                body: {
                  operationId: this.state.operationId,
                  controllerId: this.state.controllerId,
                },
                consent: true,
              }),
            );
            if (this.state.seat) return this.state.seat;
          }
        }
      } else {
        const participation = await this.api.request(
          this.tournamentPath("participation"),
          tournamentParticipationSchema,
          { headers: { "X-Tournament-Controller": this.state.controllerId } },
        );
        if (participation.status !== lastStatus) {
          this.log("queue", { status: participation.status, type: "tournament" });
          lastStatus = participation.status;
        }
        if (participation.controller === "other")
          throw Error("別の操作元が大会のBOTを使用しています");
        if (participation.operationId) this.state.operationId = participation.operationId;
        if (participation.operationId) this.state.version = participation.controllerVersion;
        await this.save();
        if (participation.status === "matched" || participation.status === "playing") {
          const restored = await this.api.request(
            this.tournamentPath("controller"),
            tournamentControllerResponseSchema,
            {
              method: "POST",
              body: {
                operationId: participation.operationId,
                controllerId: this.state.controllerId,
                takeover: false,
                expectedControllerVersion: participation.controllerVersion,
              },
              consent: true,
            },
          );
          const p = restored.participation;
          if (!p.roomId || !p.instanceId) throw Error("大会の割当を確認できません");
          const membership = await this.api.request(
            `/api${getRoomMembershipContract.pathFor(p.roomId)}`,
            getRoomMembershipContract.response,
            { bearer: restored.token },
          );
          this.state.tournamentToken = restored.token;
          this.state.version = p.controllerVersion;
          this.state.seat = {
            roomId: p.roomId,
            instanceId: p.instanceId,
            token: restored.token,
            playerId: membership.playerId,
          };
          await this.save();
          return this.state.seat;
        }
        const detail = await this.api.request(this.tournamentPath(), tournamentDetailSchema);
        const settings = getTournamentSettings(detail.tournament);
        if (settings.game !== this.config.game || settings.mode !== "singles")
          throw Error("大会のゲーム・モードが設定と異なります");
        const ending =
          this.draining() || ["settling", "finished"].includes(detail.tournament.status);
        if (ending) {
          if (participation.status === "waiting")
            await this.api.request(this.tournamentPath("queue"), ok, {
              method: "DELETE",
              body: this.tournamentControl(),
            });
          await this.clear();
          return null;
        }
        if (detail.tournament.status !== "active") {
          await this.pause();
          continue;
        }
        if (participation.status === "waiting") {
          if (performance.now() >= heartbeatAt) {
            await this.api.request(this.tournamentPath("queue"), ok, {
              method: "PATCH",
              body: this.tournamentControl(),
            });
            heartbeatAt = performance.now() + 9000;
          }
        } else {
          await this.api.checkAccess();
          if (this.draining()) continue;
          if (!participation.entered)
            await this.api.request(
              this.tournamentPath("entries"),
              z.object({ entered: z.literal(true) }),
              { method: "POST", consent: true },
            );
          if (this.state.operationId && this.state.version !== undefined) await this.clear();
          this.state.operationId ??= crypto.randomUUID();
          this.state.tournamentToken ??=
            crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
          await this.save();
          if (this.draining()) continue;
          await this.api.request(this.tournamentPath("queue"), ok, {
            method: "POST",
            body: {
              operationId: this.state.operationId,
              controllerId: this.state.controllerId,
              token: this.state.tournamentToken,
            },
            consent: true,
          });
        }
      }
      await this.pause();
    }
    return null;
  }
  private ratedControl() {
    return {
      operationId: this.state.operationId,
      controllerId: this.state.controllerId,
      version: this.state.version,
    };
  }
  private tournamentControl() {
    return {
      operationId: this.state.operationId,
      controllerId: this.state.controllerId,
      controllerVersion: this.state.version,
    };
  }
  async clear() {
    delete this.state.operationId;
    delete this.state.version;
    delete this.state.tournamentToken;
    await this.save();
  }
  async forceCancel(): Promise<Seat | null> {
    try {
      if (this.config.target.type === "rated") {
        const current = await this.api.request(this.ratedPath(), matchmakingStateSchema);
        const assigned = await this.rememberRated(current);
        if (assigned) return assigned;
        if (current.status === "waiting")
          return this.rememberRated(
            await this.api.request(this.ratedPath("cancel"), matchmakingStateSchema, {
              method: "POST",
              body: this.ratedControl(),
              consent: true,
            }),
          );
      } else if (this.config.target.type === "tournament") {
        const p = await this.api.request(
          this.tournamentPath("participation"),
          tournamentParticipationSchema,
          { headers: { "X-Tournament-Controller": this.state.controllerId } },
        );
        if (p.controller === "other") return null;
        if (p.operationId) this.state.operationId = p.operationId;
        this.state.version = p.controllerVersion;
        if (p.status === "waiting" || p.status === "matched")
          await this.api.request(this.tournamentPath("queue"), ok, {
            method: "DELETE",
            body: this.tournamentControl(),
          });
        if (p.status === "playing") {
          const restored = await this.api.request(
            this.tournamentPath("controller"),
            tournamentControllerResponseSchema,
            {
              method: "POST",
              body: {
                operationId: p.operationId,
                controllerId: this.state.controllerId,
                takeover: false,
                expectedControllerVersion: p.controllerVersion,
              },
              consent: true,
            },
          );
          const active = restored.participation;
          if (active.roomId && active.instanceId) {
            const membership = await this.api.request(
              `/api${getRoomMembershipContract.pathFor(active.roomId)}`,
              getRoomMembershipContract.response,
              { bearer: restored.token },
            );
            this.state.seat = {
              roomId: active.roomId,
              instanceId: active.instanceId,
              token: restored.token,
              playerId: membership.playerId,
            };
            await this.save();
          }
        }
      }
    } catch (error) {
      this.log("cancel_pending", {
        reason: error instanceof ApiError ? error.code : "state_unavailable",
      });
    }
    return this.state.seat ?? null;
  }
}
