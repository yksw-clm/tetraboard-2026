const paths = {
  arrow: "M5 12h14m-6-6 6 6-6 6",
  plus: "M12 5v14M5 12h14",
  join: "M14 4h5v16h-5M3 12h11m-4-4 4 4-4 4",
  refresh: "M20 7v5h-5M4 17v-5h5m-4.4-4A8 8 0 0 1 18 6l2 2M4 16l2 2a8 8 0 0 0 13.4-2",
  help: "M9.5 9a2.5 2.5 0 1 1 4.2 1.8c-1.1.8-1.7 1.2-1.7 2.7M12 17h.01",
  close: "m6 6 12 12M6 18 18 6",
  users:
    "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M22 21v-2a4 4 0 0 0-3-3.9M15 3.1a4 4 0 0 1 0 7.8",
} as const;

export function LobbyIcon({ name }: { name: keyof typeof paths }) {
  return (
    <svg
      className="lobby-icon"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {name === "help" && <circle cx="12" cy="12" r="9" />}
      {name === "users" && <circle cx="9" cy="7" r="4" />}
      <path d={paths[name]} />
    </svg>
  );
}
