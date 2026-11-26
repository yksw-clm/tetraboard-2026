export function RoomEntryMessage({ message }: { message: string }) {
  return (
    <p
      className="mb-0 py-[13px] px-4 border border-solid border-[#efd9d2] rounded-[11px] text-[#98472f] bg-[#fdf4f0] text-[13px] wrap-anywhere"
      role="alert"
    >
      {message}
    </p>
  );
}
