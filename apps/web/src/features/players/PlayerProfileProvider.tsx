import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useLocation } from "react-router";
import { PlayerProfileContext, type ActivePreview } from "./usePlayerProfiles";
import { PlayerProfileStore } from "./playerProfileStore";
export function PlayerProfileProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => new PlayerProfileStore());
  const [active, setActive] = useState<ActivePreview>(null);
  const [dismissVersion, setDismissVersion] = useState(0);
  const location = useLocation();
  const activate = useCallback(
    (id: string, pinned: boolean) => setActive({ id, pinned, routeKey: location.key }),
    [location.key],
  );
  const close = useCallback((id: string, suppress = false) => {
    if (suppress) setDismissVersion((version) => version + 1);
    setActive((current) => (current?.id === id ? null : current));
  }, []);
  useEffect(() => {
    return () => store.clear();
  }, [location.key, store]);
  return (
    <PlayerProfileContext.Provider
      value={{
        store,
        active: active?.routeKey === location.key ? active : null,
        activate,
        close,
        dismissVersion,
      }}
    >
      {children}
    </PlayerProfileContext.Provider>
  );
}
