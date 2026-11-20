import boardWood from "../assets/board-wood.webp";

export const boardImageUrl = boardWood;

let preloadStarted = false;

export function preloadBoardImage(): void {
  if (typeof window === "undefined" || preloadStarted) return;
  preloadStarted = true;

  const image = new Image();
  image.fetchPriority = "high";
  image.decoding = "async";
  image.src = boardImageUrl;
}
