export type SoundEffect = "join" | "bot" | "put" | "start" | "end" | "clock";

interface SoundPlayerOptions {
  sources: Record<SoundEffect, string>;
  available: () => boolean;
  visible: () => boolean;
  configureSession: () => void;
  createContext: () => AudioContext;
  fetch: (url: string) => Promise<Response>;
}

/** 音声の失敗を操作・通信へ伝播させず、操作前の音は後から再演しません。 */
export class SoundPlayer {
  private readonly options: SoundPlayerOptions;
  private context: AudioContext | null = null;
  private readonly files = new Map<SoundEffect, Promise<ArrayBuffer>>();
  private readonly decoding = new Map<SoundEffect, Promise<void>>();
  private readonly buffers = new Map<SoundEffect, AudioBuffer>();
  private readonly playing = new Set<AudioBufferSourceNode>();
  private clockSource: AudioBufferSourceNode | null = null;
  private clockEndsAt = 0;
  private enabled = true;
  private readonly availabilityListeners = new Set<() => void>();
  private putEndsAt = 0;
  private joinScope: string | null = null;
  private roomUsers = 0;
  private readonly joined = new Set<string>();

  constructor(options: SoundPlayerOptions) {
    this.options = options;
  }

  /** #121の共通設定から呼び出す境界。設定の保存・入口はここでは扱いません。 */
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) this.stop();
    for (const listener of this.availabilityListeners) listener();
  }

  subscribeAvailability(listener: () => void): () => void {
    this.availabilityListeners.add(listener);
    return () => this.availabilityListeners.delete(listener);
  }

  private selectRoom(instanceId: string): void {
    if (this.joinScope === instanceId) return;
    this.stop();
    this.joinScope = instanceId;
    this.roomUsers = 0;
    this.joined.clear();
  }

  retainRoom(instanceId: string): () => void {
    this.selectRoom(instanceId);
    this.roomUsers++;
    return () => {
      if (this.joinScope !== instanceId) return;
      this.roomUsers--;
      // 同じ部屋の資格切替・StrictModeの再マウントで入室音を切りません。
      queueMicrotask(() => {
        if (this.joinScope === instanceId && this.roomUsers === 0) this.stop();
      });
    };
  }

  prepare(): void {
    if (!this.options.available()) return;
    for (const sound of Object.keys(this.options.sources) as SoundEffect[]) {
      if (!this.files.has(sound)) {
        const file = Promise.resolve()
          .then(() => this.options.fetch(this.options.sources[sound]))
          .then((response) => {
            if (!response.ok) throw new Error("Sound request failed");
            return response.arrayBuffer();
          });
        this.files.set(sound, file);
        void file.catch(() => this.files.delete(sound));
      }
      const context = this.context;
      if (context === null || this.buffers.has(sound) || this.decoding.has(sound)) continue;
      const decoding = this.files
        .get(sound)!
        .then((file) => context.decodeAudioData(file.slice(0)))
        .then((buffer) => {
          this.buffers.set(sound, buffer);
        })
        .catch(() => {})
        .finally(() => this.decoding.delete(sound));
      this.decoding.set(sound, decoding);
    }
  }

  activate(): void {
    if (!this.options.available() || !this.options.visible()) return;
    try {
      // 排他的なセッションで一度再生してから変更することを避けます。
      this.options.configureSession();
      if (this.context === null) {
        this.context = this.options.createContext();
        this.context.onstatechange = () => {
          if (this.context?.state !== "running") this.stopClock();
          for (const listener of this.availabilityListeners) listener();
        };
      }
      if (this.context.state !== "running") void this.context.resume().catch(() => {});
      this.prepare();
    } catch {
      // API未対応やOSの中断中も、ゲームの操作を継続します。
    }
  }

  play(sounds: readonly SoundEffect[]): void {
    const context = this.context;
    if (!this.enabled || context === null || context.state !== "running" || !this.options.visible())
      return;
    let at = context.currentTime;
    for (const sound of sounds) {
      const buffer = this.buffers.get(sound);
      if (buffer === undefined) continue;
      if (sound === "end") at = Math.max(at, this.putEndsAt);
      let source: AudioBufferSourceNode | null = null;
      try {
        source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(context.destination);
        const playing = source;
        source.onended = () => {
          this.playing.delete(playing);
          playing.disconnect();
        };
        this.playing.add(source);
        source.start(at);
        at += buffer.duration;
        if (sound === "put") this.putEndsAt = at;
      } catch {
        if (source !== null) {
          this.playing.delete(source);
          source.disconnect();
        }
      }
    }
  }

  playClock(remainingMs: number): void {
    this.stopClock();
    const context = this.context;
    const buffer = this.buffers.get("clock");
    if (
      !this.enabled ||
      context?.state !== "running" ||
      !this.options.visible() ||
      buffer === undefined ||
      remainingMs <= 0
    )
      return;
    let source: AudioBufferSourceNode | null = null;
    try {
      source = context.createBufferSource();
      this.clockSource = source;
      source.buffer = buffer;
      source.connect(context.destination);
      this.clockEndsAt = context.currentTime + Math.min(remainingMs / 1000, 5, buffer.duration);
      const playing = source;
      source.onended = () => {
        if (this.clockSource === playing) this.clockSource = null;
        playing.disconnect();
      };
      source.start(context.currentTime);
      source.stop(this.clockEndsAt);
    } catch {
      this.stopClock();
    }
  }

  updateClockDeadline(remainingMs: number): void {
    if (this.clockSource === null || this.context === null) return;
    if (remainingMs <= 0 || this.context.state !== "running") {
      this.stopClock();
      return;
    }
    try {
      this.clockSource.stop(
        Math.min(this.clockEndsAt, this.context.currentTime + remainingMs / 1000),
      );
    } catch {
      this.stopClock();
    }
  }

  stopClock(): void {
    const source = this.clockSource;
    this.clockSource = null;
    if (source === null) return;
    source.onended = null;
    try {
      source.stop();
    } catch {
      // 終了・中断済みの時計音も再演せず破棄します。
    }
    try {
      source.disconnect();
    } catch {
      // 解放済みでもゲームへ音声の失敗を伝播させません。
    }
  }

  playJoin(instanceId: string, playerId: string): void {
    this.selectRoom(instanceId);
    if (this.joined.has(playerId)) return;
    this.joined.add(playerId);
    // 同じ部屋で入退室を繰り返しても、記録を無制限に増やしません。
    if (this.joined.size > 100) this.joined.delete(this.joined.values().next().value!);
    this.play(["join"]);
  }

  stop(): void {
    this.stopClock();
    for (const source of this.playing) {
      source.onended = null;
      try {
        source.stop();
        source.disconnect();
      } catch {
        // 終了済みの音声も破棄します。
      }
    }
    this.playing.clear();
    this.putEndsAt = 0;
  }
}
