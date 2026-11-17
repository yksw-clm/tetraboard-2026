import { readProfileDetails as readDetails } from "@tetraboard/context-account";
import { profilePolicy } from "../adapters/account/profilePolicy";
export const readProfileDetails = (user: Parameters<typeof readDetails>[0]) =>
  readDetails(user, profilePolicy.parseDetails);
