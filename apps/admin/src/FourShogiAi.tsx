import { useEffect, useState } from "react";
import { Button, Card } from "@heroui/react";
import {
  aiStatusSchema,
  aiRunsSchema,
  type AiStatus,
  type AiRun,
  type AiProfile,
} from "@tetraboard/protocol/shogi-ai";
import { AdminApiError, adminRequest } from "./api";
const stages = {
  initialising: "初期化中",
  selfplay: "自己対局中",
  evaluating: "検証中",
  ready: "比較完了",
  stopped: "停止",
  failed: "エラー",
};
const date = (value: number | null) =>
  value === null ? "未保存" : new Date(value).toLocaleString("ja-JP");
const rate = (value: number | null) => (value === null ? "未測定" : `${(value * 100).toFixed(1)}%`);
export function useAiStatus() {
  const [state, setState] = useState<{
    data: AiStatus | null;
    error: string | null;
    loading: boolean;
    now: number;
  }>({ data: null, error: null, loading: true, now: Date.now() });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let disposed = false,
      busy = false,
      controller: AbortController | null = null;
    const load = async () => {
      if (disposed || busy || document.hidden) return;
      busy = true;
      controller = new AbortController();
      setState((old) => ({ ...old, loading: true, now: Date.now() }));
      try {
        const data = aiStatusSchema.parse(
          await adminRequest("/api/admin/four-shogi-ai/status", controller.signal),
        );
        if (!disposed) setState({ data, error: null, loading: false, now: Date.now() });
      } catch (error) {
        if (!disposed)
          setState((old) => ({
            ...old,
            data:
              error instanceof AdminApiError && [401, 403].includes(error.status) ? null : old.data,
            error: error instanceof Error ? error.message : "取得できません。",
            loading: false,
            now: Date.now(),
          }));
      } finally {
        busy = false;
      }
    };
    void load();
    const timer = setInterval(() => {
      setState((old) => ({ ...old, now: Date.now() }));
      void load();
    }, 10000);
    const visibility = () => {
      if (!document.hidden) void load();
      else controller?.abort();
    };
    document.addEventListener("visibilitychange", visibility);
    return () => {
      disposed = true;
      clearInterval(timer);
      controller?.abort();
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [revision]);
  return { ...state, refresh: () => setRevision((n) => n + 1) };
}
function RunHistory({ profileId }: { profileId: AiProfile }) {
  const [runs, setRuns] = useState<AiRun[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void adminRequest(`/api/admin/four-shogi-ai/runs?profileId=${profileId}`, controller.signal)
      .then(aiRunsSchema.parse)
      .then((data) => {
        if (!controller.signal.aborted) {
          setRuns(data.runs);
          setCursor(data.nextCursor);
          setError(null);
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : "取得できません。");
      });
    return () => controller.abort();
  }, [profileId]);
  const more = async () => {
    if (!cursor || busy) return;
    setBusy(true);
    try {
      const data = aiRunsSchema.parse(
        await adminRequest(`/api/admin/four-shogi-ai/runs?profileId=${profileId}&cursor=${cursor}`),
      );
      setRuns((old) => [...old, ...data.runs]);
      setCursor(data.nextCursor);
    } catch (e) {
      setError(e instanceof Error ? e.message : "取得できません。");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="overflow-x-auto p-5">
      <h2 className="font-bold">世代ごとの比較履歴</h2>
      {error && <p role="alert">{error}</p>}
      <table className="mt-3 w-full text-left text-sm">
        <thead>
          <tr>
            <th>世代</th>
            <th>状況</th>
            <th>検証局数</th>
            <th>親との報酬差・95%区間</th>
            <th>学習の親に採用</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.id}>
              <td>{run.generation}</td>
              <td>{stages[run.stage]}</td>
              <td>
                {run.completedGames}/{run.plannedGames}
              </td>
              <td>
                {run.differenceInterval
                  ? run.differenceInterval.map((n) => n.toFixed(3)).join(" 〜 ")
                  : "未測定"}
              </td>
              <td>{run.accepted ? "採用" : "見送り・検証中"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {cursor && (
        <Button isPending={busy} onPress={() => void more()}>
          続きを表示
        </Button>
      )}
    </Card>
  );
}
export function FourShogiAi() {
  const status = useAiStatus();
  const [profileId, setProfileId] = useState<AiProfile>("singles-restricted");
  const data = status.data;
  const profile = data?.profiles.find((p) => p.profileId === profileId);
  const stale = !!data && status.now - data.heartbeatAt > 30000;
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">四人将棋 Lv3・自己対局</h1>
          <p className="mt-2 text-sm text-gray-500">
            通常シングルスの学習・検証状況。対局への配布は未実施です。
          </p>
        </div>
        <Button isPending={status.loading} onPress={status.refresh}>
          更新
        </Button>
      </div>
      {status.error && (
        <p role="alert" className="rounded-lg bg-red-50 p-4 text-red-800">
          {status.error}
          {data && " 最後に取得できた値を表示しています。"}
        </p>
      )}
      {stale && <p role="alert">サーバーの更新が30秒以上止まっています。</p>}
      {!data ? (
        <p role="status">
          {status.loading
            ? "状況を取得しています…"
            : "自己対局サーバーの設定後に状況を表示します。"}
        </p>
      ) : (
        <>
          <Card className="gap-2 p-5">
            <p className="font-bold">
              {stages[data.learning.stage]} ・ {data.learning.games}局完了 ・{" "}
              {data.learning.gamesPerHour.toFixed(1)}局/時
            </p>
            <p>
              並列対局：{data.learning.activeGames.length}　試用終了：{date(data.learningEndsAt)}
            </p>
            <p>
              最新取得：{date(data.generatedAt)}　チェックポイント：
              {date(data.learning.checkpointAt)}
            </p>
            <p className="text-sm">
              {data.resources.scope === "container" ? "コンテナ全体" : "制御プロセスのみ"}のメモリ：
              {(data.resources.memoryBytes / 1024 ** 2).toFixed(0)} MB　CPU累計：
              {data.resources.cpuSeconds.toFixed(1)}秒　ディスク空き：
              {data.resources.diskFreeBytes === null
                ? "未測定"
                : `${(data.resources.diskFreeBytes / 1024 ** 3).toFixed(1)} GB`}
            </p>
            {data.learning.activeGames.map((game) => (
              <p key={game.id} className="text-sm">
                {game.profileId === "singles-restricted" ? "禁止あり" : "禁止なし"}：{game.ply}手
              </p>
            ))}
          </Card>
          <div className="flex gap-3" role="group" aria-label="学習ルール">
            {(["singles-restricted", "singles-unrestricted"] as const).map((id) => (
              <Button key={id} aria-pressed={profileId === id} onPress={() => setProfileId(id)}>
                {id === "singles-restricted" ? "３人攻撃禁止あり" : "３人攻撃禁止なし"}
              </Button>
            ))}
          </div>
          {profile && (
            <Card className="gap-2 p-5">
              <h2 className="font-bold">現在のLv3</h2>
              <p className="break-all">学習の親：{profile.champion.id}</p>
              <p className="break-all">候補：{profile.candidate?.id ?? "未作成"}</p>
              <p>
                探索予算：{profile.champion.maxWork.toLocaleString()}　エンジン：
                {profile.champion.sourceHash.slice(0, 12)}
              </p>
              {profile.run && (
                <>
                  <p>
                    第{profile.run.generation}世代：{stages[profile.run.stage]}　
                    {profile.run.completedGames}/{profile.run.plannedGames}局
                  </p>
                  <p>
                    混合相手との1位率：{rate(profile.run.metrics.winRate)}　平均順位：
                    {profile.run.metrics.averageRank?.toFixed(2) ?? "未測定"}
                  </p>
                  <p>
                    標本数：{profile.run.metrics.games}　引き分け：{profile.run.metrics.draws}
                    　未完了：{profile.run.metrics.unfinished}
                  </p>
                  <p className="text-sm text-gray-500">
                    同じ開始系列の4席で比較します。採用には別系列の検証が必要です。
                  </p>
                </>
              )}
            </Card>
          )}
          <RunHistory key={profileId} profileId={profileId} />
          {data.recentErrors.map((e, i) => (
            <p key={i} role="alert">
              {e}
            </p>
          ))}
        </>
      )}
    </div>
  );
}
