import { z } from "zod";
import { gameIds, gameScopeIds } from "./games";

export const gameIdSchema = z.enum(gameIds);
export const gameScopeSchema = z.enum(gameScopeIds);
