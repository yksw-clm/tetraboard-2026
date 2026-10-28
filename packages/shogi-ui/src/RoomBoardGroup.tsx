import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  type ComponentPropsWithoutRef,
  type ReactNode,
  type RefObject,
} from "react";

const BoardStatusContext = createContext<ReactNode>(null);

export function RoomBoardStatusProvider({
  status,
  children,
}: {
  status: ReactNode;
  children: ReactNode;
}) {
  return <BoardStatusContext.Provider value={status}>{children}</BoardStatusContext.Provider>;
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
  const status = useContext(BoardStatusContext);
  const ownRef = useRef<HTMLDivElement>(null);
  const layoutRef = ref ?? ownRef;
  const statusRef = useRef<HTMLDivElement>(null);
  const hasStatus = status !== null;

  useLayoutEffect(() => {
    const layout = layoutRef.current;
    const card = statusRef.current;
    if (!layout || !card) return;
    // 名前や操作の折り返しで変わる高さも確保し、盤面とカードを一緒に収めます。
    const reserveHeight = () => {
      const height = Math.ceil(card.getBoundingClientRect().height) || 88;
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
        ...(hasStatus ? { "--board-status-space": "96px", "--board-min-size": "0px" } : {}),
        ...(hasStatus && hasNotice ? { "--board-notice-space": "25px" } : {}),
        ...style,
      }}
    >
      {children}
      {hasStatus && (
        <div
          ref={statusRef}
          className={`col-start-1 col-end-[-1] ${hasNotice ? "row-start-5" : "row-start-4"} justify-self-center w-[var(--shogi-board-width,var(--board-size))] max-w-full min-w-0`}
        >
          {status}
        </div>
      )}
    </div>
  );
}
