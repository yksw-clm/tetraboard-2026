import type { AccountProfile } from "@tetraboard/protocol";
export type ProfileDetails = Required<Pick<AccountProfile, "profileMessage" | "favoriteGames">>;
export type ProfileDetailsParser = (input: {
  profileMessage: string;
  favoriteGames: unknown;
}) => ProfileDetails;
export function readProfileDetails(
  user: { profileMessage?: string; favoriteGames?: string },
  parse: ProfileDetailsParser,
): ProfileDetails {
  return parse({
    profileMessage: user.profileMessage ?? "",
    favoriteGames: JSON.parse(user.favoriteGames ?? "[]"),
  });
}
