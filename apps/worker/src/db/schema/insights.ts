import { integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const kpiMonthly = sqliteTable(
  "kpi_monthly",
  {
    month: text("month").notNull(),
    metric: text("metric").notNull(),
    value: real("value").notNull(),
    computedAtMs: integer("computed_at_ms").notNull(),
  },
  (t) => [primaryKey({ columns: [t.month, t.metric] })],
);
