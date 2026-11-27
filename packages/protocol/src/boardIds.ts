import { z } from "zod";

export const boardPostIdSchema = z.uuid();
export const boardPostNumberSchema = z.int().positive();

export function parseBoardPostNumber(value: string): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 && String(number) === value ? number : null;
}
