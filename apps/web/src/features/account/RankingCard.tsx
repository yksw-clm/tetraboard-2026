import { Button, Card, Tabs } from "@heroui/react";
import { useEffect, useState } from "react";
import {
  accountPaths,
  rankingSchema,
  type RankingEntry,
  type RoomMode,
} from "@tetraboard/protocol";
import { accountRequest } from "./accountApi";
import { PlayerAvatar } from "../../shared/PlayerAvatar";
export function ModeSelect({
  mode,
  onChange,
}: {
  mode: RoomMode;
  onChange: (mode: RoomMode) => void;
}) {
  return (
    <div className="account-modes" role="group" aria-label="対局モード">
      {(["singles", "doubles"] as const).map((value) => (
        <Button
          key={value}
          size="sm"
          variant={mode === value ? "primary" : "secondary"}
          aria-pressed={mode === value}
          onPress={() => onChange(value)}
        >
          {value === "singles" ? "シングルス" : "ダブルス"}
        </Button>
      ))}
    </div>
  );
}
export function RankingCard() {
  const [mode, setMode] = useState<RoomMode>("singles");
  const [metric, setMetric] = useState<"wins" | "games">("wins");
  const [entries, setEntries] = useState<RankingEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    void accountRequest(`${accountPaths.ranking}?mode=${mode}&metric=${metric}`)
      .then((body) => {
        if (active) setEntries(rankingSchema.parse(body).entries);
      })
      .catch(() => {
        if (active) setError("ランキングを読み込めませんでした。");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [mode, metric, retry]);
  const label = metric === "games" ? "対局数" : mode === "singles" ? "優勝数" : "勝利数";
  return (
    <Card className="ranking-card">
      <h2>
        ランキング <small>通算</small>
      </h2>
      <ModeSelect
        mode={mode}
        onChange={(value) => {
          if (value !== mode) {
            setMode(value);
            setLoading(true);
            setError(null);
          }
        }}
      />
      <Tabs
        selectedKey={metric}
        onSelectionChange={(key) => {
          if (key !== metric) {
            setMetric(key as "wins" | "games");
            setLoading(true);
            setError(null);
          }
        }}
      >
        <Tabs.List aria-label="ランキングの種類">
          {["wins", "games"].map((key) => (
            <Tabs.Tab key={key} id={key}>
              {key === "games" ? "対局数" : mode === "singles" ? "優勝数" : "勝利数"}
              <Tabs.Indicator />
            </Tabs.Tab>
          ))}
        </Tabs.List>
        <Tabs.Panel key={metric} id={metric}>
          {loading ? (
            <p role="status">読み込み中…</p>
          ) : error ? (
            <p role="alert">
              {error}
              <Button
                variant="secondary"
                size="sm"
                onPress={() => {
                  setRetry(retry + 1);
                  setLoading(true);
                  setError(null);
                }}
              >
                再読み込み
              </Button>
            </p>
          ) : entries.length === 0 ? (
            <p className="account-muted">まだ対局の記録がありません。</p>
          ) : (
            <ol className="ranking-list">
              {entries.map((entry) => (
                <li key={entry.username}>
                  <span className="ranking-position">{entry.rank}</span>
                  <PlayerAvatar avatarUrl={entry.avatarUrl} />
                  <span className="ranking-name">{entry.name}</span>
                  <strong aria-label={`${label} ${entry.count}`}>
                    {entry.count}
                    <small>局</small>
                  </strong>
                </li>
              ))}
            </ol>
          )}
        </Tabs.Panel>
      </Tabs>
    </Card>
  );
}
