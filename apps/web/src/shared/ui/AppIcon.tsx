import { cn } from "@heroui/react";
import { type ComponentPropsWithRef } from "react";

const paths = {
  eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Zm13 0a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z",
  trophy:
    "M8 3h8v6a4 4 0 0 1-8 0V3Zm8 2h4v2a4 4 0 0 1-4 4M8 5H4v2a4 4 0 0 0 4 4m4 2v5m-5 3h10m-8 0v-3h6v3",
  home: "m3 10 9-7 9 7v11h-7v-8h-4v8H3V10Z",
  book: "M12 5c-3-2-7-2-10-1v15c3-1 7-1 10 1m0-15c3-2 7-2 10-1v15c-3-1-7-1-10 1V5Z",
  camera:
    "M4 6h4l2-3h4l2 3h4a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Zm12 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z",
  chevronDown: "m6 9 6 6 6-6",
  arrow: "M5 12h14m-6-6 6 6-6 6",
  plus: "M12 5v14M5 12h14",
  join: "M14 4h5v16h-5M3 12h11m-4-4 4 4-4 4",
  rotateClockwise: "M20 7v5h-5M20 12a8 8 0 1 0-2.3 5.7",
  refresh:
    "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8M21 3v5h-5M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16M8 16H3v5",
  help: "M9.5 9a2.5 2.5 0 1 1 4.2 1.8c-1.1.8-1.7 1.2-1.7 2.7M12 17h.01",
  close: "m6 6 12 12M6 18 18 6",
  users:
    "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M22 21v-2a4 4 0 0 0-3-3.9M15 3.1a4 4 0 0 1 0 7.8",
  copy: "M8 8h13v13H8V8ZM16 8V3H3v13h5",
  user: "M5 21v-2a7 7 0 0 1 14 0v2",
  crown: "m3 6 4 4 5-7 5 7 4-4-2 13H5L3 6Zm3 10h12",
  robot: "M12 2v3M5 7h14v13H5V7ZM2 11v5m20-5v5M8 11h1m6 0h1m-7 5h6",
  board: "M3 3h18v18H3V3Zm6 0v18m6-18v18M3 9h18M3 15h18",
  chat: "M21 11a8 8 0 0 1-8 8H8l-5 3V11a9 9 0 0 1 18 0ZM7 11h10",
  clock: "M12 8v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0",
  leave: "M9 4H4v16h5M10 12h11m-4-4 4 4-4 4",
  send: "m22 2-7 20-4-9-9-4 20-7ZM11 13 22 2",
  down: "M12 4v16m-6-6 6 6 6-6",
  settings: "M4 7h16M4 17h16M8 4v6m8 4v6",
  preferences:
    "M9.43 4.95L10.26 2.15L13.74 2.15L14.57 4.95L16.82 6.25L19.66 5.57L21.40 8.58L19.39 10.70L19.39 13.30L21.40 15.42L19.66 18.43L16.82 17.75L14.57 19.05L13.74 21.85L10.26 21.85L9.43 19.05L7.18 17.75L4.34 18.43L2.60 15.42L4.61 13.30L4.61 10.70L2.60 8.58L4.34 5.57L7.18 6.25Z M15 12a3 3 0 1 0-6 0 3 3 0 0 0 6 0",
} as const;

export type AppIconName = keyof typeof paths;

export function AppIcon({
  name,
  className,
  ...props
}: Omit<ComponentPropsWithRef<"svg">, "children"> & { name: AppIconName }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
      className={cn("shrink-0 align-middle", className)}
    >
      <path d={paths[name]} />
      {name === "help" && <circle cx="12" cy="12" r="9" />}
      {name === "users" && <circle cx="9" cy="7" r="4" />}
      {name === "user" && <circle cx="12" cy="7" r="4" />}
    </svg>
  );
}
