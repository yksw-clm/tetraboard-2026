import { matchHistoryFilterSchema, type MatchHistoryFilter } from "@tetraboard/protocol";
import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router";
import { useAccount } from "./useAccount";

export function useMatchHistoryFilter() {
  const { user } = useAccount();
  const owner = user?.profileId ?? user?.username;
  const location = useLocation();
  const navigate = useNavigate();
  const state = location.state ?? {};
  const saved = state.accountHistoryFilter;
  const value = matchHistoryFilterSchema.safeParse(saved?.value);
  const filter: MatchHistoryFilter =
    owner && saved?.owner === owner && value.success ? value.data : "all";
  const setFilter = (value: MatchHistoryFilter) => {
    void navigate(location.pathname + location.search + location.hash, {
      replace: true,
      state: { ...state, accountHistoryFilter: { owner, value } },
    });
  };
  useEffect(() => {
    if (owner && saved && saved.owner !== owner) {
      void navigate(location.pathname + location.search + location.hash, {
        replace: true,
        state: { ...state, accountHistoryFilter: { owner, value: "all" } },
      });
    }
  }, [owner, saved, navigate, location.pathname, location.search, location.hash, state]);
  return { filter, setFilter };
}
