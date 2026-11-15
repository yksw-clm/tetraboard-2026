import { integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { user } from "./auth";

export const accountInsightsReady = sqliteTable(
  "account_insights_ready",
  {
    accountId: text("account_id").references(() => user.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.accountId] })],
);

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
