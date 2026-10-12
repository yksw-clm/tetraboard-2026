import { useState } from "react";
import { formationCatalog } from "@tetraboard/four-shogi/formation-catalog";
import { AppButton } from "../../shared/ui/AppButton";
import { AppDialog } from "../../shared/ui/AppDialog";
import { StatsTable, type StatsRow } from "./StatsTable";
import { formatStatsRate } from "./statsPresentation";
import type { useFormationStats } from "./useFormationStats";

export default function FormationStats({ data }: { data: ReturnType<typeof useFormationStats> }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = data.stats?.find((entry) => entry.id === selectedId);
  const definition = formationCatalog.find((entry) => entry.id === selectedId);
  return (
    <section
      aria-labelledby="formation-stats-title"
      className="min-w-0 border-0 border-t border-solid border-line pt-4"
    >
      <h3 id="formation-stats-title" className="mb-3 text-base font-bold">
        戦法別戦績
      </h3>
      {data.loading && (
        <p role="status" className="text-sm text-muted">
          戦法別戦績を読み込んでいます…
        </p>
      )}
      {data.stats && (
        <>
          <div className="flex min-w-0 gap-3 overflow-x-auto pb-3" aria-label="戦法一覧">
            {formationCatalog.map((formation) => {
              const experienced = data.stats!.some((entry) => entry.id === formation.id);
              return (
                <AppButton
                  key={formation.id}
                  appearance="secondary"
                  isDisabled={!experienced}
                  aria-label={experienced ? `${formation.name}の戦績` : "未経験の戦法"}
                  onPress={() => setSelectedId(formation.id)}
                  className="w-[180px] flex-col justify-start gap-2 rounded-panel p-3 whitespace-normal text-sm disabled:opacity-100"
                >
                  <span
                    className="flex h-[120px] w-full items-center justify-center rounded-control bg-surface-muted"
                    aria-hidden="true"
                  >
                    {experienced ? (
                      <img
                        src={`/four-shogi/formations/${formation.id}.jpg`}
                        alt=""
                        loading="lazy"
                        className="h-full w-full object-contain"
                      />
                    ) : (
                      <span className="text-3xl text-muted">?</span>
                    )}
                  </span>
                  <span className="min-h-10 w-full text-center [overflow-wrap:anywhere]">
                    {experienced ? formation.name : "???"}
                  </span>
                </AppButton>
              );
            })}
          </div>
          <p className="mt-1 text-xs text-muted">
            複数の戦法を使用した対局は、それぞれの戦法に集計します。
          </p>
        </>
      )}
      {data.error && (
        <div className="mt-3 flex flex-col items-start gap-2">
          <p role="alert" className="text-sm text-danger">
            {data.error}
          </p>
          <AppButton
            appearance="secondary"
            size="compact"
            aria-label="戦法別戦績を再試行"
            isDisabled={data.loading}
            isPending={data.pendingSource === "retry"}
            onPress={() => void data.refresh("retry")}
          >
            再試行
          </AppButton>
        </div>
      )}
      {selected && definition && (
        <AppDialog title={definition.name} theme="four-shogi" onClose={() => setSelectedId(null)}>
          <p className="mb-4 text-sm text-muted">この戦法を使用した対局の戦績です。</p>
          <StatsTable
            label={`${definition.name}の戦績`}
            rows={[
              [{ label: "使用対局数", value: selected.total }],
              ...[
                { label: "優勝", count: selected.first },
                { label: "2位", count: selected.second },
                { label: "3位", count: selected.third },
                { label: "4位", count: selected.fourth },
              ].map(({ label, count }): StatsRow => [
                { label: `${label}数`, value: count },
                { label: `${label}率`, value: formatStatsRate(count, selected.total) },
              ]),
            ]}
          />
        </AppDialog>
      )}
    </section>
  );
}
