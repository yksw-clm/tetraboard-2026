import { createContext, useContext } from "react";
import type { AccountProfile } from "@tetraboard/protocol";
export const AccountContext = createContext<{
  user: AccountProfile | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}>({ user: null, loading: true, error: null, refresh: async () => {} });
export const useAccount = () => useContext(AccountContext);
