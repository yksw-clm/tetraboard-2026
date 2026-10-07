import { createContext, use } from "react";
import { PlayerProfileStore } from "./playerProfileStore";
export type ActivePreview = { id: string; pinned: boolean; routeKey: string } | null;
export const PlayerProfileContext = createContext<{
  store: PlayerProfileStore;
  active: ActivePreview;
  activate: (id: string, pinned: boolean) => void;
  close: (id: string, suppress?: boolean) => void;
  dismissVersion: number;
} | null>(null);
export const usePlayerProfiles = () => use(PlayerProfileContext);
