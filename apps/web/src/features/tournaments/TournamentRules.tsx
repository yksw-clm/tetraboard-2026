import { AppCard } from "../../shared/ui/AppCard";
export function TournamentRules({ description }: { description: string }) {
  return (
    <AppCard className="gap-5">
      <h2 className="text-lg font-bold">大会ルール</h2>
      {description && (
        <p className="whitespace-pre-wrap wrap-anywhere text-sm leading-relaxed text-ink-secondary">
          {description}
        </p>
      )}
      <div className="grid gap-5 md:grid-cols-[1fr_1fr]">
        <div className="space-y-4 text-sm leading-relaxed text-ink-secondary">
          <p>
            大会期間中は、エントリーしたプレイヤー同士でランダムマッチを行います。1局ごとの勝ち点を積み重ね、合計点で大会順位を決めます。
          </p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-2">
            <dt className="text-muted">対局形式</dt>
            <dd>四人将棋・シングルス（人間4人）</dd>
            <dt className="text-muted">時間設定</dt>
            <dd>持ち時間なし・秒読み30秒</dd>
            <dt className="text-muted">三人攻撃禁止</dt>
            <dd>ON</dd>
            <dt className="text-muted">参加条件</dt>
            <dd>登録済み・エントリー済みのユーザー</dd>
          </dl>
          <p>
            途中参加・途中退出ができます。CPU補充はありません。大会の「対局する」から始まった対局だけが得点対象です。
          </p>
        </div>
        <div>
          <h3 className="mb-3 text-sm font-bold">1局ごとの勝ち点</h3>
          <div className="grid grid-cols-4 gap-2">
            {[4, 2, 1, 0].map((point, index) => (
              <div
                key={point}
                className={`rounded-control border border-solid p-3 text-center ${index === 0 ? "border-lobby-play-line bg-surface-muted" : "border-line"}`}
              >
                <span className="text-xs text-muted">
                  {index === 0 ? "優勝" : `${index + 1}位`}
                </span>
                <strong className="mt-1 block text-xl">
                  {point}
                  <span className="ml-0.5 text-xs font-normal">点</span>
                </strong>
              </div>
            ))}
          </div>
          <h3 className="mt-5 mb-2 text-sm font-bold">勝ち点が同じ場合</h3>
          <ol className="m-0 space-y-1 pl-5 text-sm text-ink-secondary">
            <li>撃破数が多いプレイヤー</li>
            <li>平均順位がよいプレイヤー（数値が小さい）</li>
            <li>すべて同じ場合は同順位</li>
          </ol>
        </div>
      </div>
      <details className="border-t border-solid border-line pt-4 text-sm text-ink-secondary">
        <summary className="min-h-8 cursor-pointer font-semibold text-brand">
          同順位・引き分け・終了時刻について
        </summary>
        <ul className="mt-3 space-y-2 pl-5 leading-relaxed">
          <li>
            大会では合意による引き分けは使いません。千日手などの同順位は、占める順位の点を均等配分します。全員引き分けなら各1.75点、2人が同時に下位へ脱落した場合は各0.5点です。
          </li>
          <li>平均順位は表示上の丸め値ではなく、丸める前の値で比較します。</li>
          <li>
            撃破は着手で相手を詰ませた場合に数えます。投了・時間切れ・通信切れなどは含めません。
          </li>
          <li>
            開催時間内に開始した大会対局は、終了時刻を過ぎても最後まで得点対象です。終了時刻以降は新しい大会対局を開始できません。
          </li>
          <li>
            すべての対象対局の終了と結果保存を待って順位を確定します。同率優勝は全員を表彰し、有効対局が0局なら表彰しません。
          </li>
        </ul>
      </details>
    </AppCard>
  );
}
