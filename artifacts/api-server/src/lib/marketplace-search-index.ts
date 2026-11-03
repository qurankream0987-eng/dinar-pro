/**
 * C1 — the searchable text of each listing, stored in offer_search_documents (migration 0045, originally 0041 on the C1 branch).
 *
 * The text is produced by exactly the function the search itself applies (`searchableTextOf`), so a
 * fresh document can stand in for the in-memory computation in the SQL candidate stage. Freshness
 * is enforced by the database, not by every write path:
 *  - a trigger bumps offers.search_revision and sets search_document_stale on any `data` change, on
 *    insert, and on any change to a category the listing names (label, aliases, attributes);
 *  - only this refresher clears the flag, in the same statement that writes the document, and only
 *    if the revision it read is still current — a racing edit can never leave stale text behind;
 *  - a stale row is always a search candidate, so a missing document can widen the candidate set
 *    but never hide a listing.
 * The read path never writes; maintenance runs from the server's background loop or a backfill.
 */
import { inArray, sql } from "drizzle-orm";
import { db, offerSearchDocuments, offers, type users } from "@workspace/db";
import { normalizeSearch } from "../ai/search-context";
import { categorySchema as categorySchemaFromRow, listMarketplaceCategories, type MarketplaceCategoryRow } from "./marketplace-categories";
import { logger } from "./logger";

/** Bump when `searchableTextOf` changes: older documents then stop counting as fresh. */
export const SEARCH_TEXT_VERSION = 1;

type Offer = typeof offers.$inferSelect;
export type SearchTextContext = {
  schemasById: Map<string, ReturnType<typeof categorySchemaFromRow>>;
  categoryIdsByLabel: Map<string, string>;
};

export function searchTextContext(allCategories: readonly MarketplaceCategoryRow[]): SearchTextContext {
  return {
    schemasById: new Map(allCategories.map((item) => [item.id, categorySchemaFromRow(item)])),
    categoryIdsByLabel: new Map(allCategories.map((item) => [item.label, item.id])),
  };
}

/** The text a search matches: title, description, category, city, area and searchable attributes. */
export function searchableTextOf(offer: Pick<Offer, "data">, context: SearchTextContext): string {
  return normalizeSearch(
    [
      offer.data.title,
      offer.data.description,
      offer.data.category,
      offer.data.city,
      offer.data.area,
      ...Object.entries(
        context.schemasById.get(
          typeof offer.data.categoryId === "string"
            ? offer.data.categoryId
            : context.categoryIdsByLabel.get(String(offer.data.category ?? "")) ?? "",
        )?.attributes ?? {},
      )
        .filter(([, definition]) => definition.searchable !== false)
        .map(([field]) => offer.data.attributes?.[field]),
    ]
      .filter((value) => value != null)
      .join(" "),
  );
}

/**
 * Writes documents for the given rows (or claims the next `limit` stale rows), each only if its
 * revision is still the current one. Returns how many were written.
 *
 * The automatic path claims its rows with row locks inside one short transaction: a second replica
 * that ticks at the same moment skips the locked rows and rebuilds a different slice, so N replicas
 * do N times less duplicate work instead of N times the same work. The claim costs one extra round
 * trip (the slice is read again, once every row in it is locked) and holds those locks only while
 * the documents are built — a cost bounded by `limit` and measured in wave05-d13-db-profile. The
 * revision guard in writeDocuments still decides what lands: a concurrent edit makes this claim's
 * own write match nothing.
 */
export async function refreshSearchDocuments(
  input: { limit?: number; marketId?: string; rows?: Array<{ offer: Offer; seller?: typeof users.$inferSelect }> } = {},
): Promise<{ refreshed: number; considered: number }> {
  if (input.rows) return writeDocuments(input.rows.map((row) => row.offer));
  const limit = Math.min(Math.max(input.limit ?? 200, 1), 2_000);
  const staleWhere = input.marketId
    ? sql`${offers.searchDocumentStale} AND ${offers.marketId} = ${input.marketId}`
    : sql`${offers.searchDocumentStale}`;
  return db.transaction(async (tx) => {
    const ids = (
      await tx
        .select({ id: offers.id })
        .from(offers)
        .where(staleWhere)
        .limit(limit)
        .for("update", { skipLocked: true })
    ).map((row) => row.id);
    if (!ids.length) return { refreshed: 0, considered: 0 };
    // Every row of the slice is locked by this transaction now, so this read sees it whole and
    // nobody else can claim it while its documents are built.
    const rows = await tx.select().from(offers).where(inArray(offers.id, ids));
    return writeDocuments(rows, tx);
  });
}

/** Either the pool-backed database or a transaction: the only thing this builder needs is `execute`. */
type DocumentExecutor = Pick<typeof db, "execute">;

async function writeDocuments(
  rows: Offer[],
  executor: DocumentExecutor = db,
): Promise<{ refreshed: number; considered: number }> {
  if (!rows.length) return { refreshed: 0, considered: 0 };
  const context = searchTextContext(await listMarketplaceCategories(true));
  let refreshed = 0;
  for (let offset = 0; offset < rows.length; offset += 1_000) {
    const chunk = rows.slice(offset, offset + 1_000);
    // One statement per chunk: for each row, clear the flag only for the revision its text was built
    // from, and write the document in the same step. A concurrent edit (a new revision) matches nothing.
    const result = await executor.execute(sql`
      WITH input AS (
        SELECT * FROM unnest(${sql.param(chunk.map((offer) => offer.id))}::text[], ${sql.param(chunk.map((offer) => String(offer.searchRevision)))}::bigint[], ${sql.param(chunk.map((offer) => searchableTextOf(offer, context)))}::text[]) AS i(id, revision, search_text)
      ), current AS (
        UPDATE ${offers} o SET search_document_stale = false
        FROM input
        WHERE o.id = input.id AND o.search_revision = input.revision
        RETURNING o.id, o.search_revision, input.search_text
      )
      INSERT INTO ${offerSearchDocuments} (offer_id, search_text, source_revision, text_version, updated_at)
      SELECT id, search_text, search_revision, ${SEARCH_TEXT_VERSION}, now() FROM current
      ON CONFLICT (offer_id) DO UPDATE SET
        search_text = excluded.search_text,
        source_revision = excluded.source_revision,
        text_version = excluded.text_version,
        updated_at = excluded.updated_at
      RETURNING offer_id`);
    refreshed += result.rows.length;
  }
  return { refreshed, considered: rows.length };
}

export async function staleSearchDocumentCount(marketId?: string): Promise<number> {
  const result = await db.execute(
    marketId
      ? sql`SELECT count(*)::int AS n FROM ${offers} WHERE search_document_stale AND market_id = ${marketId}`
      : sql`SELECT count(*)::int AS n FROM ${offers} WHERE search_document_stale`,
  );
  return Number((result.rows[0] as { n: number }).n);
}

let versionCheck: { at: number; ready: boolean } | undefined;
/**
 * Whether every stored document was built by this code's text version. If not (a version bump not
 * yet re-indexed), the SQL stage stops using document text at all: slower, never wrong.
 */
export async function searchTextVersionReady(now = Date.now()): Promise<boolean> {
  if (versionCheck && now - versionCheck.at < 30_000) return versionCheck.ready;
  const result = await db.execute(
    sql`SELECT 1 FROM ${offerSearchDocuments} WHERE text_version < ${SEARCH_TEXT_VERSION} OR text_version > ${SEARCH_TEXT_VERSION} LIMIT 1`,
  );
  versionCheck = { at: now, ready: result.rows.length === 0 };
  return versionCheck.ready;
}
export function resetSearchTextVersionCache() {
  versionCheck = undefined;
}

/** Re-marks rows whose document is from another text version, so the refresher rebuilds them. */
export async function invalidateOtherTextVersions(limit = 2_000): Promise<number> {
  const result = await db.execute(sql`
    UPDATE ${offers} SET search_document_stale = true
    WHERE id IN (
      SELECT offer_id FROM ${offerSearchDocuments}
      WHERE text_version < ${SEARCH_TEXT_VERSION} OR text_version > ${SEARCH_TEXT_VERSION}
      LIMIT ${limit}
    ) AND NOT search_document_stale
    RETURNING id`);
  return result.rows.length;
}

/**
 * Background maintenance for the server: rebuild other-version documents, then refresh stale rows in
 * bounded batches. Never on the request path; failures are logged and retried on the next tick.
 */
export function startSearchIndexMaintenance(intervalMs = 30_000): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await invalidateOtherTextVersions();
      let total = 0;
      for (let round = 0; round < 10; round++) {
        const { refreshed } = await refreshSearchDocuments({ limit: 500 });
        total += refreshed;
        if (refreshed < 500) break;
      }
      if (total) logger.info({ event: "dinar_search_index_refreshed", documents: total }, "search documents refreshed");
      resetSearchTextVersionCache();
    } catch (error) {
      logger.warn({ event: "dinar_search_index_refresh_failed", reason: error instanceof Error ? error.message.slice(0, 200) : "unknown" }, "search index refresh failed");
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
