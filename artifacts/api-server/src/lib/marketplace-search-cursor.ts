import { db, offers, users, pool } from "@workspace/db";
import { and, asc, desc, eq, getTableColumns, inArray, sql, type SQL } from "drizzle-orm";
import type { SearchFilter } from "@workspace/api-zod/marketplace-schemas";
import type { OfferRow } from "./marketplace-listings";

export const SEARCH_BATCH_SIZE = 128;

/** SQL predicates here are necessary conditions, never lossy approximations of Arabic matching. */
export function searchCandidateQuery(input: {
  marketId: string;
  ownSellerId?: string;
  allowedIds?: string[];
  conversational?: boolean;
  category?: { id: string; label: string };
  filters?: SearchFilter[];
  minorUnitScale: number;
  order?: { field: string; direction: string; attribute?: string };
}) {
  const predicates: SQL[] = [eq(offers.marketId, input.marketId), eq(users.status, "ACTIVE")];
  predicates.push(input.ownSellerId ? eq(offers.sellerId, input.ownSellerId) : eq(offers.status, "PUBLISHED"));
  if (input.allowedIds) predicates.push(input.allowedIds.length ? inArray(offers.id, input.allowedIds) : sql`false`);
  if (input.conversational) predicates.push(sql`(${offers.inventoryMode} = 'UNLIMITED' OR coalesce(${offers.availableQuantity}, 0) - ${offers.reservedQuantity} > 0)`);
  if (input.category) {
    // Legacy label fallback is allowed exactly when categoryId is falsy in JavaScript.
    predicates.push(sql`(${offers.data}->'categoryId' = ${JSON.stringify(input.category.id)}::jsonb OR
      ((${offers.data}->'categoryId' IS NULL OR ${offers.data}->'categoryId' IN ('null'::jsonb, 'false'::jsonb, '0'::jsonb, '""'::jsonb))
       AND ${offers.data}->'category' = ${JSON.stringify(input.category.label)}::jsonb))`);
  }
  for (const filter of input.filters ?? []) {
    if (filter.field !== "price" || typeof filter.value !== "number") continue;
    const operators: Record<string, string> = { eq: "=", ne: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" };
    const operator = operators[filter.operator];
    if (!operator) continue;
    // Coarse integer range is deliberately a superset (±1 minor unit), enabling the
    // B-tree before the exact float comparison without changing boundary semantics.
    const minor = filter.value * 10 ** input.minorUnitScale;
    const clamp = (value: number) => Math.max(-2147483648, Math.min(2147483647, value));
    if (Number.isFinite(minor)) {
      if (["eq", "gt", "gte"].includes(filter.operator)) predicates.push(sql`${offers.unitPriceMinor} >= ${clamp(Math.floor(minor) - 1)}`);
      if (["eq", "lt", "lte"].includes(filter.operator)) predicates.push(sql`${offers.unitPriceMinor} <= ${clamp(Math.ceil(minor) + 1)}`);
    }
    // Preserve JS division/comparison rather than rounding a fractional minor-unit bound.
    predicates.push(sql`(${offers.unitPriceMinor}::float8 / ${10 ** input.minorUnitScale}::float8) ${sql.raw(operator)} ${filter.value}::float8`);
  }
  const order: SQL[] = [];
  if (input.order) {
    const value = input.order.field === "PRICE" ? offers.unitPriceMinor
      : input.order.field === "CREATED_AT" ? offers.createdAt
      : sql`dinar_search_number(${offers.data}->'attributes'->${input.order.attribute ?? ""})`;
    order.push(sql`${value} ${sql.raw(input.order.direction === "ASC" ? "asc" : "desc")} nulls last`, desc(offers.createdAt));
  } else {
    // Previously no ORDER BY: the observed insertion order had no SQL guarantee.
    // Timestamp then id defines repeatable new results; stored ids retain their own order.
    order.push(asc(offers.createdAt));
  }
  order.push(asc(offers.id));
  return db.select({ offer: offers, seller: users }).from(offers)
    .innerJoin(users, eq(users.id, offers.sellerId)).where(and(...predicates)).orderBy(...order);
}

/** Server cursor: one repeatable-read snapshot, fixed transfers, no OFFSET or whole-market array. */
export async function* searchCandidateBatches(input: Parameters<typeof searchCandidateQuery>[0]): AsyncGenerator<OfferRow[]> {
  const query = searchCandidateQuery(input).toSQL();
  const client = await pool.connect();
  const offerColumns = Object.entries(getTableColumns(offers));
  const sellerColumns = Object.entries(getTableColumns(users));
  const decode = (values: unknown[], columns: Array<[string, { mapFromDriverValue(value: any): unknown }]>, offset: number) => Object.fromEntries(
    columns.map(([key, column], index) => {
      const value = values[offset + index];
      return [key, value == null ? value : column.mapFromDriverValue(value)];
    }),
  );
  try {
    await client.query("BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ");
    await client.query(`DECLARE dinar_search_cursor NO SCROLL CURSOR FOR ${query.sql}`, query.params);
    for (;;) {
      const result = await client.query({ text: `FETCH FORWARD ${SEARCH_BATCH_SIZE} FROM dinar_search_cursor`, rowMode: "array" });
      if (!result.rows.length) break;
      yield result.rows.map((values: unknown[]) => ({
        offer: decode(values, offerColumns, 0),
        seller: decode(values, sellerColumns, offerColumns.length),
      } as OfferRow));
    }
  } finally {
    // Also releases the snapshot/cursor on early return, thrown policy error or consumer failure.
    try { await client.query("ROLLBACK"); } finally { client.release(); }
  }
}
