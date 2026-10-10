import { useEffect } from "react";
import { SoundPlayer } from "./soundPlayer";
import { browserSettings } from "./browserSettings";

export const roomSounds = new SoundPlayer({
  sources: {
    join: new URL("../assets/sounds/join.mp3", import.meta.url).href,
    bot: new URL("../assets/sounds/bot.mp3", import.meta.url).href,
    put: new URL("../assets/sounds/put.mp3", import.meta.url).href,
    start: new URL("../assets/sounds/start.mp3", import.meta.url).href,
    end: new URL("../assets/sounds/end.mp3", import.meta.url).href,
    clock: new URL("../assets/sounds/clock.mp3", import.meta.url).href,
  },
  available: () => typeof window.AudioContext === "function",
  visible: () => document.visibilityState === "visible",
  configureSession: () => {
    const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
    if (session !== undefined) session.type = "ambient";
  },
  createContext: () => new window.AudioContext(),
  fetch: (url) => fetch(url),
});

roomSounds.setEnabled(browserSettings.getSnapshot().soundEnabled);
browserSettings.subscribe(() => roomSounds.setEnabled(browserSettings.getSnapshot().soundEnabled));

/** captureで非同期の参加処理・着手処理より先に音声を有効化します。 */
export function useSoundEffects(): void {
  useEffect(() => {
    roomSounds.prepare();
    const activate = (event: Event) => {
      if (event.isTrusted) roomSounds.activate();
    };
    const visibilityChanged = () => {
      if (document.visibilityState !== "visible") roomSounds.stop();
    };
    document.addEventListener("click", activate, true);
    document.addEventListener("pointerup", activate, true);
    document.addEventListener("keydown", activate, true);
    document.addEventListener("visibilitychange", visibilityChanged);
    return () => {
      document.removeEventListener("click", activate, true);
      document.removeEventListener("pointerup", activate, true);
      document.removeEventListener("keydown", activate, true);
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, []);
}
