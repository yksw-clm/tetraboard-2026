export type QueryParams = Record<string, string | number | boolean | null>;
export type QueryRow = Record<string, unknown>;

export interface UsageEventQuery {
  rows(query: string, params: QueryParams): Promise<QueryRow[]>;
}

export type KpiEnv = {
  APP_DB: D1Database;
  ANALYTICS_SQL?: AnalyticsSQLBinding;
  USAGE_EVENTS_DATASET?: string;
};

export function usageDataset(name: string | undefined): string {
  if (!name || !/^[A-Za-z0-9_]+$/.test(name)) throw new Error("Invalid usage events dataset");
  return `events.analyticsEngine."${name}"`;
}

export function createUsageEventQuery(env: KpiEnv): UsageEventQuery {
  return {
    async rows(query, params) {
      const binding = env.ANALYTICS_SQL;
      if (!binding) throw new Error("Analytics SQL binding unavailable");
      const rows: QueryRow[] = [];
      let offset = 0;
      for (let page = 0; page < 20; page++) {
        let data: QueryRow[];
        for (let attempt = 0; ; attempt++) {
          try {
            const result = await binding.query({
              query: `${query} LIMIT 10000 OFFSET ${offset}`,
              params,
            });
            data = result.data;
            break;
          } catch (error) {
            if (
              attempt >= 2 ||
              !error ||
              typeof error !== "object" ||
              !("retryable" in error) ||
              error.retryable !== true
            )
              throw error;
            await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
          }
        }
        if (!data.length) return rows;
        rows.push(...data);
        offset += data.length;
      }
      throw new Error("Usage event query exceeded 20 pages");
    },
  };
}
