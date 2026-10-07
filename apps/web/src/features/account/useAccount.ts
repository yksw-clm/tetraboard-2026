import { createContext, useContext } from "react";
import type { AccountProfile } from "@tetraboard/protocol";
export const AccountContext = createContext<{
  user: AccountProfile | null;
  loading: boolean;
  error: string | null;
  pendingSource?: string | null;
  refresh: (source?: string) => Promise<void>;
  update: (user: AccountProfile | null) => void;
} | null>(null);
export function useAccount() {
  const account = useContext(AccountContext);
  if (!account) throw new Error("AccountLayout is required");
  return account;
}
