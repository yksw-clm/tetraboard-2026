export function initialReplayIndex(position: string | null, frameCount: number) {
  const lastIndex = frameCount - 1;
  if (position === null || !/^\d+$/.test(position)) return lastIndex;
  const index = Number(position);
  return index <= lastIndex ? index : lastIndex;
}
