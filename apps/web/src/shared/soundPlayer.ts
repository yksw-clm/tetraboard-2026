export type SoundEffect = "join" | "bot" | "put" | "start" | "end";

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
  private putEndsAt = 0;
  private joinScope: string | null = null;
  private roomUsers = 0;
  private readonly joined = new Set<string>();

  constructor(options: SoundPlayerOptions) {
    this.options = options;
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
      this.context ??= this.options.createContext();
      if (this.context.state !== "running") void this.context.resume().catch(() => {});
      this.prepare();
    } catch {
      // API未対応やOSの中断中も、ゲームの操作を継続します。
    }
  }

  play(sounds: readonly SoundEffect[]): void {
    const context = this.context;
    if (context === null || context.state !== "running" || !this.options.visible()) return;
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

  playJoin(instanceId: string, playerId: string): void {
    this.selectRoom(instanceId);
    if (this.joined.has(playerId)) return;
    this.joined.add(playerId);
    // 同じ部屋で入退室を繰り返しても、記録を無制限に増やしません。
    if (this.joined.size > 100) this.joined.delete(this.joined.values().next().value!);
    this.play(["join"]);
  }

  stop(): void {
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
