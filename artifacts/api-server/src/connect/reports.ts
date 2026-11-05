import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import {
  db,
  connectPartners,
  connectOffers,
  connectReferrals,
  connectIntegrations,
  connectSites,
  connectTransactions,
  connectCommissionLedger,
} from "@workspace/db";
import { z } from "zod";
import { ConnectPartnerReportSchema } from "@workspace/api-zod/connect-platform";
import { currencyScale } from "@workspace/global";
import { connectError } from "./provider-registry";
import {
  connectAccess,
  assertConnectAdmin,
  type ConnectActor,
  type ConnectMarket,
} from "./partners";
import { connectBalancesForReport, transactionView } from "./finance";
const querySchema = z
  .object({
    cursor: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(50).default(25),
  })
  .strict();
export async function connectPartnerReport(
  actor: ConnectActor,
  market: ConnectMarket,
  partnerId: string,
  rawQuery: unknown,
  admin = false,
) {
  const query = querySchema.parse(rawQuery);
  return db.transaction(
    async (tx) => {
      if (admin) {
        await assertConnectAdmin(actor, tx);
        const [partner] = await tx
          .select({ id: connectPartners.id })
          .from(connectPartners)
          .where(
            and(
              eq(connectPartners.id, partnerId),
              eq(connectPartners.marketId, market.id),
            ),
          );
        if (!partner) throw connectError(404, "NOT_FOUND", "الشريك غير موجود");
      } else
        await connectAccess(actor.id, market.id, partnerId, "REPORTS_READ", tx);
      let cursorFilter;
      if (query.cursor) {
        const [cursor] = await tx
          .select({
            id: connectTransactions.id,
            createdAt: connectTransactions.createdAt,
          })
          .from(connectTransactions)
          .where(
            and(
              eq(connectTransactions.id, query.cursor),
              eq(connectTransactions.partnerId, partnerId),
            ),
          );
        if (!cursor)
          throw connectError(404, "NOT_FOUND", "مؤشر التقرير غير موجود");
        cursorFilter = or(
          lt(connectTransactions.createdAt, cursor.createdAt),
          and(
            eq(connectTransactions.createdAt, cursor.createdAt),
            lt(connectTransactions.id, cursor.id),
          ),
        );
      }
      const rows = await tx
        .select()
        .from(connectTransactions)
        .where(and(eq(connectTransactions.partnerId, partnerId), cursorFilter))
        .orderBy(
          desc(connectTransactions.createdAt),
          desc(connectTransactions.id),
        )
        .limit(query.limit + 1);
      const aggregate = await tx
        .select({
          currency: connectTransactions.currencyCode,
          mode: connectTransactions.mode,
          earnedMinor: sql<string>`coalesce(sum(${connectCommissionLedger.deltaMinor}) filter(where ${connectCommissionLedger.bucket}='EARNED'),0)::text`,
          approvedMinor: sql<string>`coalesce(sum(${connectCommissionLedger.deltaMinor}) filter(where ${connectCommissionLedger.bucket}='APPROVED'),0)::text`,
          payableMinor: sql<string>`coalesce(sum(${connectCommissionLedger.deltaMinor}) filter(where ${connectCommissionLedger.bucket}='PAYABLE'),0)::text`,
          simulatedSettledMinor: sql<string>`coalesce(sum(${connectCommissionLedger.deltaMinor}) filter(where ${connectCommissionLedger.bucket}='SIMULATED_SETTLED'),0)::text`,
          recoveryDueMinor: sql<string>`coalesce(sum(${connectCommissionLedger.deltaMinor}) filter(where ${connectCommissionLedger.bucket}='RECOVERY_DUE'),0)::text`,
        })
        .from(connectTransactions)
        .leftJoin(
          connectCommissionLedger,
          eq(connectCommissionLedger.transactionId, connectTransactions.id),
        )
        .where(eq(connectTransactions.partnerId, partnerId))
        .groupBy(connectTransactions.currencyCode, connectTransactions.mode);
      const totals = aggregate.map((row) => {
        for (const key of [
          "earnedMinor",
          "approvedMinor",
          "payableMinor",
          "simulatedSettledMinor",
          "recoveryDueMinor",
        ] as const)
          if (!/^\d+$/.test(row[key]))
            throw connectError(
              500,
              "LEDGER_RECONCILIATION_REQUIRED",
              "يلزم تدقيق أرصدة التقرير",
            );
        return {
          ...row,
          minorUnitScale: currencyScale(row.currency),
          actuallyReceivedMinor: row.mode === "SIMULATION_ONLY" ? "0" : null,
        };
      });
      const counts = async (table: any) => {
        const [row] = await tx
          .select({ n: sql<string>`count(*)::text` })
          .from(table)
          .where(eq(table.partnerId, partnerId));
        return row!.n;
      };
      const [offers, referrals, integrations, sites] = await Promise.all([
        counts(connectOffers),
        counts(connectReferrals),
        counts(connectIntegrations),
        counts(connectSites),
      ]);
      const shown = rows.slice(0, query.limit);
      const balances = await connectBalancesForReport(
        tx,
        shown.map((row) => row.id),
      );
      const transactions = shown.map((row) =>
        transactionView(row, balances.get(row.id)!),
      );
      return ConnectPartnerReportSchema.parse({
        partnerId,
        generatedAt: new Date().toISOString(),
        counts: {
          offers,
          preparedConsentedReferrals: referrals,
          integrations,
          sites,
        },
        totals,
        transactions,
        nextCursor: rows.length > query.limit ? shown.at(-1)!.id : null,
        internalOrdersCreated: 0,
        disclosure:
          "سجل مستقل للتجارة الخارجية. الإحالات المُعدّة ليست مشتريات. أرصدة العملات منفصلة ولا تُحوّل تلقائيًا. التسويات الاصطناعية لا تثبت استلام مال حقيقي.",
      });
    },
    { isolationLevel: "repeatable read" },
  );
}
