import { createElement, type ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { AccountContext } from "../src/features/account/useAccount";
import type { AccountProfile } from "@tetraboard/protocol";
// eslint-disable-next-line react/only-export-components -- Test helpers are not Fast Refresh components.
export * from "./support";
export function wrap(
  user: AccountProfile | null = null,
  entry: string | { pathname: string; state: unknown } = "/",
) {
  return (child: ReactNode) =>
    createElement(
      MemoryRouter,
      { initialEntries: [entry] },
      createElement(
        AccountContext.Provider,
        { value: { user, loading: false, error: null, refresh: async () => {}, update: () => {} } },
        child,
      ),
    );
}
