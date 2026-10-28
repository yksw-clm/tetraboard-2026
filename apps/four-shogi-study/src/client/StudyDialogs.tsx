import { useState } from "react";
import { defaultStudySettings, type StudySettings } from "../shared/model";
import type { StudySession } from "./useStudySession";
import { Button, Dialog, Field, fieldClass } from "./ui";
import { sideNames, sideOrder } from "./presentation";

export function NewStudyDialog({ session, close }: { session: StudySession; close(): void }) {
  const [title, setTitle] = useState("新しい検討");
  const [seats, setSeats] = useState<StudySettings["seats"]>(defaultStudySettings.seats);
  const [prohibited, setProhibited] = useState(true);
  return (
    <Dialog title="新しい対局" busy={session.pending} onClose={close}>
      <form
        className="space-y-5"
        onSubmit={(event) => {
          event.preventDefault();
          void session
            .create({ title, threePlayerAttackProhibited: prohibited, settings: { seats } })
            .then((ok) => {
              if (ok) close();
            });
        }}
      >
        <Field label="検討名">
          <input
            className={fieldClass}
            value={title}
            maxLength={100}
            onChange={(event) => setTitle(event.target.value)}
            autoFocus
          />
        </Field>
        <SeatSettings seats={seats} setSeats={setSeats} />
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={prohibited}
            onChange={(event) => setProhibited(event.target.checked)}
          />
          三人攻撃禁止を有効にする
        </label>
        <p className="text-xs leading-relaxed text-[#88947a]">
          持ち時間なし。人間の席はすべてあなたが操作します。「対局を再開」でCPUが自動着手します。検討モードでは全席の合法手を試せます。
        </p>
        <Button
          variant="primary"
          type="submit"
          className="w-full"
          isDisabled={session.pending || !title.trim()}
        >
          検討を作成
        </Button>
        {session.error ? (
          <p role="alert" className="text-xs text-[#ac5746]">
            {session.error}
          </p>
        ) : null}
      </form>
    </Dialog>
  );
}

function SeatSettings({
  seats,
  setSeats,
}: {
  seats: StudySettings["seats"];
  setSeats(value: StudySettings["seats"]): void;
}) {
  return (
    <fieldset className="space-y-3">
      <legend className="mb-2 text-xs font-semibold">各席の担当とCPUの思考時間</legend>
      {sideOrder.map((side) => (
        <div key={side} className="grid grid-cols-2 gap-3">
          <Field label={`${sideNames[side]}の担当`}>
            <select
              className={fieldClass}
              value={seats[side].controller}
              onChange={(event) =>
                setSeats({
                  ...seats,
                  [side]: { ...seats[side], controller: event.target.value as "human" | "cpu" },
                })
              }
            >
              <option value="human">人間</option>
              <option value="cpu">CPU</option>
            </select>
          </Field>
          <Field label={`${sideNames[side]}CPUの思考時間（秒）`}>
            <input
              className={fieldClass}
              type="number"
              min="0.1"
              max="3600"
              step="0.1"
              disabled={seats[side].controller !== "cpu"}
              value={seats[side].thinkTimeMs / 1000}
              onChange={(event) =>
                setSeats({
                  ...seats,
                  [side]: {
                    ...seats[side],
                    thinkTimeMs: Math.round(Number(event.target.value) * 1000),
                  },
                })
              }
            />
          </Field>
        </div>
      ))}
    </fieldset>
  );
}

export function ImportDialog({ session, close }: { session: StudySession; close(): void }) {
  const [url, setUrl] = useState("");
  const [fileError, setFileError] = useState<string | null>(null);
  async function load(file: File | undefined) {
    if (!file) return;
    setFileError(null);
    if (file.size > 20 * 1024 * 1024) {
      setFileError("20MB以下のファイルを選んでください。");
      return;
    }
    try {
      if (await session.importStudy({ data: JSON.parse(await file.text()) })) close();
    } catch {
      setFileError("JSON形式の検討ファイルまたは棋譜ファイルを選んでください。");
    }
  }
  return (
    <Dialog title="棋譜・検討を読み込む" onClose={close} busy={session.pending}>
      <div className="space-y-6">
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void session.importStudy({ url: url.trim() }).then((ok) => {
              if (ok) close();
            });
          }}
        >
          <Field label="TetraBoardの公開棋譜URL">
            <input
              type="url"
              className={fieldClass}
              placeholder="https://…/matches/…"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              autoFocus
            />
          </Field>
          <Button
            type="submit"
            className="w-full"
            variant="primary"
            isDisabled={session.pending || !url.trim()}
          >
            公開棋譜を読み込む
          </Button>
        </form>
        <div className="border-t border-[#e1e7d9] pt-5">
          <Field
            label="保存ファイルから読み込む"
            help="検討の分岐を含むJSON、またはTetraBoardの棋譜JSONを選べます。"
          >
            <input
              className={`${fieldClass} text-xs`}
              type="file"
              accept=".json,application/json"
              disabled={session.pending}
              onChange={(event) => void load(event.target.files?.[0])}
            />
          </Field>
        </div>
        {fileError || session.error ? (
          <p role="alert" className="text-xs leading-relaxed text-[#ae5545]">
            {fileError ?? session.error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
export function SettingsDialog({ session, close }: { session: StudySession; close(): void }) {
  const study = session.snapshot!.study;
  const [title, setTitle] = useState(study.title);
  const [seconds, setSeconds] = useState((study.settings.analysisTimeMs ?? 5000) / 1000);
  const [continuous, setContinuous] = useState(study.settings.analysisTimeMs === null);
  const [searchStrategy, setSearchStrategy] = useState(study.settings.searchStrategy ?? "adaptive");
  const [threads, setThreads] = useState(study.settings.threads);
  const [memoryMb, setMemoryMb] = useState(study.settings.memoryMb);
  const [seats, setSeats] = useState(study.settings.seats);
  const [base, setBase] = useState(
    JSON.stringify({ title: study.title, settings: study.settings }),
  );
  const changedElsewhere =
    base !== JSON.stringify({ title: study.title, settings: study.settings });
  function reload() {
    setTitle(study.title);
    setSeconds((study.settings.analysisTimeMs ?? 5000) / 1000);
    setContinuous(study.settings.analysisTimeMs === null);
    setSearchStrategy(study.settings.searchStrategy ?? "adaptive");
    setThreads(study.settings.threads);
    setMemoryMb(study.settings.memoryMb);
    setSeats(study.settings.seats);
    setBase(JSON.stringify({ title: study.title, settings: study.settings }));
  }
  return (
    <Dialog title="検討の設定" busy={session.pending} onClose={close}>
      <form
        className="space-y-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (changedElsewhere) return;
          void session
            .command({
              type: "settings",
              title: title.trim(),
              settings: {
                searchStrategy,
                analysisTimeMs: continuous ? null : Math.round(seconds * 1000),
                seats,
                threads,
                memoryMb,
              },
            })
            .then((ok) => {
              if (ok) close();
            });
        }}
      >
        {changedElsewhere ? (
          <div role="alert" className="space-y-2 text-xs text-[#a95042]">
            別の操作で設定が更新されました。現在の下書きを確認してから設定を読み直してください。
            <Button onPress={reload}>設定を読み直す</Button>
          </div>
        ) : null}
        <Field label="検討名">
          <input
            className={fieldClass}
            value={title}
            maxLength={100}
            onChange={(event) => setTitle(event.target.value)}
          />
        </Field>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={continuous}
            onChange={(event) => setContinuous(event.target.checked)}
          />
          停止するまで検討する
        </label>
        <Field label="探索方式" help="主要候補の深掘りは、広く比較した深さと分けて表示します。">
          <select
            className={fieldClass}
            value={searchStrategy}
            onChange={(event) => setSearchStrategy(event.target.value as "adaptive" | "dual")}
          >
            <option value="adaptive">幅広く検討する（v5）</option>
            <option value="dual">主要候補を深掘りする（v6）</option>
          </select>
        </Field>
        <Field label="1回の検討時間（秒）" help="再解析は新しい時間予算で開始します。">
          <input
            className={fieldClass}
            type="number"
            min="0.1"
            max="3600"
            step="0.1"
            disabled={continuous}
            value={seconds}
            onChange={(event) => setSeconds(Number(event.target.value))}
          />
        </Field>
        <div className="flex flex-wrap gap-2">
          {[1, 5, 15, 30, 60].map((value) => (
            <Button
              key={value}
              onPress={() => {
                setContinuous(false);
                setSeconds(value);
              }}
            >
              {value}秒
            </Button>
          ))}
        </div>
        <SeatSettings seats={seats} setSeats={setSeats} />
        <Field
          label="探索プロセス数"
          help={`論理CPU数：${session.config?.logicalCpus ?? "—"}。OS用に2個を残します。`}
        >
          <input
            className={fieldClass}
            type="number"
            min="1"
            max={Math.min(32, Math.max(1, (session.config?.logicalCpus ?? 4) - 2))}
            step="1"
            value={threads}
            onChange={(event) => setThreads(Number(event.target.value))}
          />
        </Field>
        <Field
          label="探索メモリの上限（MiB）"
          help={`搭載メモリ：約${Math.round((session.config?.totalMemoryMb ?? 0) / 1024)} GiB。上限は75%です。`}
        >
          <input
            className={fieldClass}
            type="number"
            min="256"
            max={Math.min(65536, Math.floor((session.config?.totalMemoryMb ?? 8192) * 0.75))}
            step="128"
            value={memoryMb}
            onChange={(event) => setMemoryMb(Number(event.target.value))}
          />
        </Field>
        <div className="rounded-lg bg-[#edf2e7] p-3 text-[11px] text-[#758469]">
          Macに自動保存します。
          <p className="mt-1 break-all font-mono text-[10px]">{session.config?.dataDirectory}</p>
        </div>
        <Button
          variant="primary"
          type="submit"
          className="w-full"
          isDisabled={session.pending || !title.trim() || changedElsewhere}
        >
          設定を保存
        </Button>
        {session.error ? (
          <p role="alert" className="text-xs text-[#a95042]">
            {session.error}
          </p>
        ) : null}
      </form>
    </Dialog>
  );
}

export function LiveDialog({ session, close }: { session: StudySession; close(): void }) {
  const [url, setUrl] = useState("");
  return (
    <Dialog title="ライブ対局を観戦する" busy={session.pending} onClose={close}>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void session.watch(url.trim()).then((ok) => {
            if (ok) close();
          });
        }}
      >
        <Field label="TetraBoardのルームURL">
          <input
            className={fieldClass}
            type="url"
            value={url}
            placeholder="https://tetraboard.net/rooms/12345?instanceId=…"
            onChange={(event) => setUrl(event.target.value)}
            autoFocus
          />
        </Field>
        <p className="text-xs leading-relaxed text-[#758469]">
          開始済みの四人将棋シングルスを観戦します。履歴取得APIが提供されている環境で利用できます。推奨手はこのMacで計算します。
        </p>
        <Button
          type="submit"
          variant="primary"
          className="w-full"
          isDisabled={session.pending || !url.trim()}
        >
          観戦して検討する
        </Button>
        {session.error ? (
          <p role="alert" className="text-xs text-[#a95042]">
            {session.error}
          </p>
        ) : null}
      </form>
    </Dialog>
  );
}
