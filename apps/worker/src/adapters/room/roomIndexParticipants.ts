import { playerAppearanceSchema } from "@tetraboard/protocol";
import { z } from "zod";

export const indexedParticipantsSchema = z
  .array(
    z.strictObject({
      playerId: z.uuid(),
      appearance: playerAppearanceSchema,
    }),
  )
  .max(4);
export type IndexedRoomParticipant = z.infer<typeof indexedParticipantsSchema>[number];
