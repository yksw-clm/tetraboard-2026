import { useAccount } from "../account/useAccount";

export function useViewerKey() {
  const { user } = useAccount();
  return JSON.stringify([user?.profileId ?? user?.username, user?.isGuest, user?.profileCompleted]);
}
