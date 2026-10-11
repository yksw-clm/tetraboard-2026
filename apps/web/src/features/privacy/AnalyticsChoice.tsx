import { useState } from "react";
import { analyticsEnabled, setAnalyticsEnabled } from "../../analytics/preference";
export function AnalyticsChoice() {
  const [enabled, setEnabled] = useState(analyticsEnabled);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-2 text-sm">
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => {
            const next = e.target.checked;
            setEnabled(next);
            setError(null);
            void setAnalyticsEnabled(next).catch(() =>
              setError(
                next
                  ? "計測の再開設定を保存できませんでした。設定をもう一度変更してください。"
                  : "このブラウザの送信は停止しましたが、対局中の計測設定を更新できませんでした。設定をもう一度変更してください。",
              ),
            );
          }}
        />
        サービス改善のための利用計測を有効にする（このブラウザ）
      </label>
      <p>停止しても対局・ログイン・棋譜・戦績は利用できます。</p>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
