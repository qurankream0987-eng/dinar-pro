/** Append a new commercial policy version (admin route and the guarded operator command share it). */
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { commercialPolicies, db } from "@workspace/db";
import { CommercialPolicySchema, getCommercialPolicy } from "./commercial-policy";
import { PLAN_CODES } from "./subscription-plans";

const refuse = (status: number, message: string, code: string) => Object.assign(new Error(message), { status, code, expose: true });

export async function appendCommercialPolicy(input: { marketId?: string; policy: unknown; actorId: string | null }) {
  const partial = CommercialPolicySchema.partial().parse(input.policy);
  const current = await getCommercialPolicy(input.marketId ?? "");
  const { version: _version, ...base } = current;
  const merged = CommercialPolicySchema.parse({ ...base, ...partial });
  // D1: a changed reference price must carry a new price version (the history stays readable).
  for (const code of PLAN_CODES) {
    const before = base.subscriptionPlans.plans[code];
    const after = merged.subscriptionPlans.plans[code];
    if (JSON.stringify(before.referencePrice) !== JSON.stringify(after.referencePrice) && after.priceVersion <= before.priceVersion)
      throw refuse(400, `تغيير سعر ${after.nameAr} يحتاج إصدار تسعير أعلى من ${before.priceVersion}`, "PRICE_VERSION_REQUIRED");
    if (after.priceVersion < before.priceVersion) throw refuse(400, "لا يمكن إرجاع إصدار التسعير", "PRICE_VERSION_REQUIRED");
  }
  const [latest] = await db
    .select({ version: sql<number>`coalesce(max(${commercialPolicies.version}), 0)::int` })
    .from(commercialPolicies)
    .where(input.marketId ? eq(commercialPolicies.marketId, input.marketId) : sql`${commercialPolicies.marketId} is null`);
  const [row] = await db
    .insert(commercialPolicies)
    .values({ id: randomUUID(), marketId: input.marketId ?? null, version: (latest?.version ?? 0) + 1, policy: merged, createdBy: input.actorId })
    .returning();
  return { id: row!.id, marketId: row!.marketId, version: row!.version, policy: row!.policy };
}
