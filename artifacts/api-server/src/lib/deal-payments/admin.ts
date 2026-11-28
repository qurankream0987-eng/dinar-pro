import { randomUUID } from "node:crypto";
import { db, dealPaymentCatalogChanges } from "@workspace/db";
import { METHODS, resolveCountry } from "./catalog";
import { DealPaymentError } from "./service";

/**
 * Records one catalog change (append-only). ACTIVE needs a source reference (also a DB check); a
 * method unknown to the code needs its label and kind, so a new method is configuration, not code.
 */
export async function recordCatalogChange(input: {
  actorId: string;
  countryCode: string;
  methodCode: string | null;
  status: "ACTIVE" | "LIMITED" | "UNAVAILABLE" | "UNDER_REVIEW";
  labelAr?: string;
  kind?: "DIRECT" | "COD";
  currencies?: string[];
  sourceReference?: string;
  reason: string;
}) {
  if (input.status === "ACTIVE" && !input.sourceReference?.trim())
    throw new DealPaymentError(400, "SOURCE_REQUIRED", "التفعيل يحتاج مصدر تحقق موثّقًا لتوفر الوسيلة في هذا البلد.");
  if (input.methodCode && !METHODS[input.methodCode] && (!input.labelAr?.trim() || !input.kind))
    throw new DealPaymentError(400, "NEW_METHOD_NEEDS_DEFINITION", "الوسيلة الجديدة تحتاج اسمًا عربيًا ونوعًا (DIRECT أو COD).");
  const row = {
    id: randomUUID(),
    countryCode: input.countryCode,
    methodCode: input.methodCode,
    status: input.status,
    labelAr: input.labelAr?.trim() || null,
    kind: input.kind ?? null,
    currencies: input.currencies ?? null,
    sourceReference: input.sourceReference?.trim() || null,
    reason: input.reason.trim(),
    actorId: input.actorId,
  };
  await db.insert(dealPaymentCatalogChanges).values(row);
  return { change: { ...row }, country: await resolveCountry(input.countryCode) };
}
