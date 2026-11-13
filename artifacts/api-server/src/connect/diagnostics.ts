import { and, desc, eq, gte, inArray, lt, or, sql } from "drizzle-orm";
import {
  db,
  businessProfiles,
  connectPartners,
  connectIntegrations,
  connectSites,
  providerConnections,
  providerCredentials,
  connectOffers,
  connectIngestionBatches,
  connectAuditEvents,
  connectTransactions,
  connectCommissionLedger,
} from "@workspace/db";
import {
  ConnectDiagnosticsQuerySchema,
  ConnectDiagnosticsSchema,
  ConnectSyncObservationSchema,
} from "@workspace/api-zod/connect-platform";
import {
  assertConnectAdmin,
  connectAccess,
  type ConnectActor,
  type ConnectMarket,
} from "./partners";
import { connectError } from "./provider-registry";
export async function connectDiagnostics(
  actor: ConnectActor,
  market: ConnectMarket,
  partnerId: string,
  rawQuery: unknown,
  admin = false,
) {
  const query = ConnectDiagnosticsQuerySchema.parse(rawQuery),
    now = new Date(),
    windowStart = new Date(now.getTime() - 86400_000);
  return db.transaction(
    async (tx) => {
      if (admin) await assertConnectAdmin(actor, tx);
      else await connectAccess(actor.id, market.id, partnerId, "OWNER", tx);
      const [context] = await tx
        .select({ partner: connectPartners, business: businessProfiles })
        .from(connectPartners)
        .innerJoin(
          businessProfiles,
          eq(businessProfiles.id, connectPartners.businessId),
        )
        .where(
          and(
            eq(connectPartners.id, partnerId),
            eq(connectPartners.marketId, market.id),
          ),
        );
      if (!context) throw connectError(404, "NOT_FOUND", "الشريك غير موجود");
      let integrationBefore, auditBefore;
      if (query.integrationCursor) {
        const [cursor] = await tx
          .select({
            id: connectIntegrations.id,
            createdAt: connectIntegrations.createdAt,
          })
          .from(connectIntegrations)
          .where(
            and(
              eq(connectIntegrations.id, query.integrationCursor),
              eq(connectIntegrations.partnerId, partnerId),
            ),
          );
        if (!cursor)
          throw connectError(404, "NOT_FOUND", "مؤشر الربط غير موجود");
        integrationBefore = or(
          lt(connectIntegrations.createdAt, cursor.createdAt),
          and(
            eq(connectIntegrations.createdAt, cursor.createdAt),
            lt(connectIntegrations.id, cursor.id),
          ),
        );
      }
      if (query.auditCursor) {
        const [cursor] = await tx
          .select({
            id: connectAuditEvents.id,
            createdAt: connectAuditEvents.createdAt,
          })
          .from(connectAuditEvents)
          .where(
            and(
              eq(connectAuditEvents.id, query.auditCursor),
              eq(connectAuditEvents.partnerId, partnerId),
            ),
          );
        if (!cursor)
          throw connectError(404, "NOT_FOUND", "مؤشر التدقيق غير موجود");
        auditBefore = or(
          lt(connectAuditEvents.createdAt, cursor.createdAt),
          and(
            eq(connectAuditEvents.createdAt, cursor.createdAt),
            lt(connectAuditEvents.id, cursor.id),
          ),
        );
      }
      const rows = await tx
        .select({
          integration: connectIntegrations,
          site: connectSites,
          connectionStatus: providerConnections.status,
          lastSuccessfulIngressAt: providerConnections.lastSuccessfulSyncAt,
        })
        .from(connectIntegrations)
        .innerJoin(
          connectSites,
          and(
            eq(connectSites.id, connectIntegrations.siteId),
            eq(connectSites.partnerId, partnerId),
          ),
        )
        .leftJoin(
          providerConnections,
          and(
            eq(
              providerConnections.id,
              connectIntegrations.providerConnectionId,
            ),
            eq(providerConnections.namespace, "CONNECT"),
            eq(providerConnections.marketId, market.id),
            eq(providerConnections.ownerUserId, context.business.ownerUserId),
          ),
        )
        .where(
          and(eq(connectIntegrations.partnerId, partnerId), integrationBefore),
        )
        .orderBy(
          desc(connectIntegrations.createdAt),
          desc(connectIntegrations.id),
        )
        .limit(query.limit + 1);
      const shown = rows.slice(0, query.limit),
        ids = shown.map((row) => row.integration.id);
      const catalog = ids.length
        ? await tx
            .select({
              integrationId: connectOffers.integrationId,
              status: connectOffers.status,
              n: sql<string>`count(*)::text`,
              stale: sql<string>`count(*) filter(where ${connectOffers.sourceCheckedAt}<${windowStart})::text`,
            })
            .from(connectOffers)
            .where(
              and(
                eq(connectOffers.partnerId, partnerId),
                inArray(connectOffers.integrationId, ids),
              ),
            )
            .groupBy(connectOffers.integrationId, connectOffers.status)
        : [];
      const credentials = ids.length
        ? await tx
            .select({
              integrationId: connectIntegrations.id,
              n: sql<string>`count(${providerCredentials.id}) filter(where ${providerCredentials.revokedAt} is null)::text`,
            })
            .from(connectIntegrations)
            .leftJoin(
              providerConnections,
              and(
                eq(
                  providerConnections.id,
                  connectIntegrations.providerConnectionId,
                ),
                eq(providerConnections.namespace, "CONNECT"),
                eq(providerConnections.marketId, market.id),
                eq(
                  providerConnections.ownerUserId,
                  context.business.ownerUserId,
                ),
              ),
            )
            .leftJoin(
              providerCredentials,
              eq(providerCredentials.connectionId, providerConnections.id),
            )
            .where(
              and(
                eq(connectIntegrations.partnerId, partnerId),
                inArray(connectIntegrations.id, ids),
              ),
            )
            .groupBy(connectIntegrations.id)
        : [];
      const ingestions = ids.length
        ? await tx
            .select({
              integrationId: connectIngestionBatches.integrationId,
              acceptedAt: sql<
                Date | string
              >`max(${connectIngestionBatches.createdAt})`,
            })
            .from(connectIngestionBatches)
            .where(inArray(connectIngestionBatches.integrationId, ids))
            .groupBy(connectIngestionBatches.integrationId)
        : [];
      const attempts = ids.length
        ? await tx
            .selectDistinctOn(
              [sql`${connectAuditEvents.details}->>'integrationId'`],
              {
                integrationId: sql<string>`${connectAuditEvents.details}->>'integrationId'`,
                outcome: sql<string>`${connectAuditEvents.details}->>'outcome'`,
                reason: sql<
                  string | null
                >`${connectAuditEvents.details}->>'reason'`,
                reviewedRevision: sql<string>`${connectAuditEvents.details}->>'reviewedRevision'`,
                durationMs: sql<string>`${connectAuditEvents.details}->>'durationMs'`,
                createdAt: connectAuditEvents.createdAt,
              },
            )
            .from(connectAuditEvents)
            .where(
              and(
                eq(connectAuditEvents.partnerId, partnerId),
                gte(connectAuditEvents.createdAt, windowStart),
                inArray(connectAuditEvents.action, [
                  "CATALOG_SYNC_COMPLETED",
                  "CATALOG_SYNC_FAILED",
                ]),
                inArray(
                  sql`${connectAuditEvents.details}->>'integrationId'`,
                  ids,
                ),
              ),
            )
            .orderBy(
              sql`${connectAuditEvents.details}->>'integrationId'`,
              desc(connectAuditEvents.createdAt),
              desc(connectAuditEvents.id),
            )
        : [];
      const audit = await tx
        .select({
          id: connectAuditEvents.id,
          actorKind: connectAuditEvents.actorKind,
          action: connectAuditEvents.action,
          createdAt: connectAuditEvents.createdAt,
        })
        .from(connectAuditEvents)
        .where(and(eq(connectAuditEvents.partnerId, partnerId), auditBefore))
        .orderBy(
          desc(connectAuditEvents.createdAt),
          desc(connectAuditEvents.id),
        )
        .limit(query.limit + 1);
      const [signals] = await tx
        .select({
          failed: sql<string>`count(*) filter(where ${connectAuditEvents.action}='CATALOG_SYNC_FAILED')::text`,
          protected: sql<string>`count(*) filter(where ${connectAuditEvents.action}='CATALOG_SYNC_FAILED' and ${connectAuditEvents.details}->>'reason' in ('PRIVATE_ENDPOINT','REDIRECT_REFUSED','UNSAFE_EXTERNAL_URL','MCP_INVALID_RESPONSE','MCP_REVIEW_REQUIRED','PROVIDER_HEADERS_REFUSED'))::text`,
          suspended: sql<string>`count(*) filter(where ${connectAuditEvents.action} in ('PARTNER_SUSPENDED','INTEGRATION_SUSPENDED'))::text`,
        })
        .from(connectAuditEvents)
        .where(
          and(
            eq(connectAuditEvents.partnerId, partnerId),
            gte(connectAuditEvents.createdAt, windowStart),
          ),
        );
      const [disputes] = await tx
        .select({ n: sql<string>`count(*)::text` })
        .from(connectTransactions)
        .where(
          and(
            eq(connectTransactions.partnerId, partnerId),
            eq(connectTransactions.state, "DISPUTED"),
          ),
        );
      const recoveryRows = tx
        .select({ id: connectTransactions.id })
        .from(connectTransactions)
        .innerJoin(
          connectCommissionLedger,
          eq(connectCommissionLedger.transactionId, connectTransactions.id),
        )
        .where(
          and(
            eq(connectTransactions.partnerId, partnerId),
            eq(connectCommissionLedger.bucket, "RECOVERY_DUE"),
          ),
        )
        .groupBy(connectTransactions.id)
        .having(sql`sum(${connectCommissionLedger.deltaMinor})>0`)
        .as("connect_recovery_obligations");
      const [recovery] = await tx
        .select({ n: sql<string>`count(*)::text` })
        .from(recoveryRows);
      const integrations = shown.map((row) => {
        const i = row.integration,
          counts = catalog.filter((value) => value.integrationId === i.id),
          attempt = attempts.find((value) => value.integrationId === i.id);
        const observation = attempt
          ? ConnectSyncObservationSchema.safeParse({
              integrationId: attempt.integrationId,
              outcome: attempt.outcome,
              reason: attempt.reason,
              reviewedRevision: /^\d+$/.test(attempt.reviewedRevision ?? "")
                ? Number(attempt.reviewedRevision)
                : NaN,
              durationMs: /^\d+$/.test(attempt.durationMs ?? "")
                ? Number(attempt.durationMs)
                : NaN,
            })
          : null;
        const acceptedAt = ingestions.find(
          (value) => value.integrationId === i.id,
        )?.acceptedAt;
        return {
          id: i.id,
          name: i.name,
          kind: i.kind,
          status: i.status,
          revision: i.revision,
          approvedRevision: i.approvedRevision,
          endpointConfigured: Boolean(i.endpointUrl),
          siteStatus: row.site.status,
          proofValidUntil: row.site.validUntil?.toISOString() ?? null,
          proofCurrentlyValid:
            row.site.status === "VERIFIED" &&
            Boolean(row.site.validUntil && row.site.validUntil > now),
          ingressStatus: row.connectionStatus ?? "NOT_CONFIGURED",
          activeIngressCredentials:
            credentials.find((value) => value.integrationId === i.id)?.n ?? "0",
          lastSuccessfulIngressAt:
            row.lastSuccessfulIngressAt?.toISOString() ?? null,
          lastCatalogAcceptedAt: acceptedAt
            ? new Date(acceptedAt).toISOString()
            : null,
          catalog: {
            published:
              counts.find((value) => value.status === "PUBLISHED")?.n ?? "0",
            hidden: counts.find((value) => value.status === "HIDDEN")?.n ?? "0",
            stale: counts
              .reduce((total, value) => total + BigInt(value.stale), 0n)
              .toString(),
          },
          lastObservedSync: observation?.success
            ? {
                ...observation.data,
                observedAt: attempt!.createdAt.toISOString(),
              }
            : null,
        };
      });
      return ConnectDiagnosticsSchema.parse({
        partnerId,
        generatedAt: now.toISOString(),
        observationWindowStart: windowStart.toISOString(),
        providerHealth: "NOT_PROBED",
        integrations,
        audit: audit
          .slice(0, query.limit)
          .map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
        reviewSignals: {
          failedAdmittedReads24h: signals?.failed ?? "0",
          protectedResponseRefusals24h: signals?.protected ?? "0",
          suspensions24h: signals?.suspended ?? "0",
          currentDisputes: disputes?.n ?? "0",
          recoveryObligationTransactions: recovery?.n ?? "0",
        },
        nextIntegrationCursor:
          rows.length > query.limit ? shown.at(-1)!.integration.id : null,
        nextAuditCursor:
          audit.length > query.limit ? audit[query.limit - 1]!.id : null,
        secretsIncluded: false,
        disclosure:
          "هذه سجلات جاسم المرصودة، وليست فحص اتصال حي أو ضمان توفر لدى المزوّد. تعرض المحاولات المقبولة للمزامنة خلال 24 ساعة فقط؛ رفض الدخول قبل القبول غير مشمول. إشارات المراجعة ليست حكمًا بوجود احتيال. لا تعرض مفاتيح أو محتوى محادثات.",
      });
    },
    { isolationLevel: "repeatable read" },
  );
}
