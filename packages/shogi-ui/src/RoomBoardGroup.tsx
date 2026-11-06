import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  type ComponentPropsWithoutRef,
  type ReactNode,
  type RefObject,
} from "react";

const BoardStatusContext = createContext<{ status: ReactNode; overlay?: ReactNode }>({
  status: null,
});

export function RoomBoardStatusProvider({
  status = null,
  overlay,
  children,
}: {
  status?: ReactNode;
  overlay?: ReactNode;
  children: ReactNode;
}) {
  return (
    <BoardStatusContext.Provider value={{ status, overlay }}>
      {children}
    </BoardStatusContext.Provider>
  );
}

export function RoomBoardGroup({
  children,
  ref,
  style,
  hasNotice = false,
  ...props
}: ComponentPropsWithoutRef<"div"> & {
  ref?: RefObject<HTMLDivElement | null>;
  hasNotice?: boolean;
}) {
  const { status, overlay } = useContext(BoardStatusContext);
  const ownRef = useRef<HTMLDivElement>(null);
  const layoutRef = ref ?? ownRef;
  const statusRef = useRef<HTMLDivElement>(null);
  const hasStatus = status !== null;

  useLayoutEffect(() => {
    const layout = layoutRef.current;
    const card = statusRef.current;
    if (!layout || !card) return;
    // 状況カードの高さと間隔を確保し、盤面と一緒に収めます。
    const reserveHeight = () => {
      const height = Math.ceil(card.getBoundingClientRect().height) || 48;
      layout.style.setProperty("--board-status-space", `${height + 8}px`);
    };
    reserveHeight();
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(reserveHeight);
    });
    observer.observe(card);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [hasStatus, layoutRef]);

  return (
    <div
      {...props}
      ref={layoutRef}
      data-with-status={hasStatus || undefined}
      style={{
        ...(hasStatus ? { "--board-status-space": "56px", "--board-min-size": "0px" } : {}),
        ...(hasStatus && hasNotice ? { "--board-notice-space": "25px" } : {}),
        ...style,
      }}
    >
      {children}
      {overlay && (
        <div className="[grid-area:board] z-[1] place-self-center pointer-events-none">
          {overlay}
        </div>
      )}
      {hasStatus && (
        <div
          ref={statusRef}
          className={`col-start-1 col-end-[-1] ${hasNotice ? "row-start-5" : "row-start-4"} justify-self-center w-[max(320px,var(--shogi-board-width,var(--board-size)))] max-w-full min-w-0`}
        >
          {status}
        </div>
      )}
    </div>
  );
}
