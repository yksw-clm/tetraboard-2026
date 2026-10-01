const paths = {
  copy: "M8 8h13v13H8V8ZM16 8V3H3v13h5",
  user: "M5 21v-2a7 7 0 0 1 14 0v2",
  crown: "m3 6 4 4 5-7 5 7 4-4-2 13H5L3 6Zm3 10h12",
  robot: "M12 2v3M5 7h14v13H5V7ZM2 11v5m20-5v5M8 11h1m6 0h1m-7 5h6",
  board: "M3 3h18v18H3V3Zm6 0v18m6-18v18M3 9h18M3 15h18",
  chat: "M21 11a8 8 0 0 1-8 8H8l-5 3V11a9 9 0 0 1 18 0ZM7 11h10",
  clock: "M12 8v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0",
  leave: "M9 4H4v16h5M10 12h11m-4-4 4 4-4 4",
  send: "m22 2-7 20-4-9-9-4 20-7ZM11 13 22 2",
  close: "m6 6 12 12M6 18 18 6",
  down: "M12 4v16m-6-6 6 6 6-6",
  settings: "M4 7h16M4 17h16M8 4v6m8 4v6",
  plus: "M12 5v14M5 12h14",
} as const;

export function RoomIcon({ name }: { name: keyof typeof paths }) {
  return (
    <svg
      className="room-icon"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
      {name === "user" && <circle cx="12" cy="7" r="4" />}
    </svg>
  );
}
