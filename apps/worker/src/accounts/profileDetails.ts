import { profileDetailsSchema } from "@tetraboard/protocol";

export function readProfileDetails(user: { profileMessage?: string; favoriteGames?: string }) {
  return profileDetailsSchema.parse({
    profileMessage: user.profileMessage ?? "",
    favoriteGames: JSON.parse(user.favoriteGames ?? "[]"),
  });
}
