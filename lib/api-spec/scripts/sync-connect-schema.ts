/** Reproducibly embed the authored Connect validation schema in the source OpenAPI contract. */
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  UniversalCardsPayloadSchema,
  ConnectReferralDisclosureSchema,
  ConnectOutboundInputSchema,
} from "../../api-zod/src/connect";
import {
  ConnectFinancialReceiptSchema,
  ConnectPartnerReportSchema,
  ConnectExternalTransactionSchema,
  ConnectAgreementTerms,
  ConnectAgreementAcceptInput,
  ConnectPartnerEvent,
  ConnectFinanceCommand,
  ConnectPartnerInput,
  ConnectSiteInput,
  ConnectIntegrationInput,
  ConnectReviewInput,
  ConnectCatalogBatch,
  ConnectTeamInput,
  ConnectSiteCommandInput,
  ConnectCatalogSyncInput,
  ConnectOAuthStatusSchema,
} from "../../api-zod/src/connect-platform";
const require = createRequire(
  new URL("../../api-zod/package.json", import.meta.url),
);
const { z } = require("zod");
const schema = z.toJSONSchema(UniversalCardsPayloadSchema);
delete schema.$schema;
function normalize(node: unknown): void {
  if (Array.isArray(node)) {
    node.forEach(normalize);
    return;
  }
  if (!node || typeof node !== "object") return;
  const item = node as Record<string, any>;
  // Orval's response date coercion cannot combine regex() with Date. A null
  // alternative must precede coercion: new Date(null) would invent an epoch time.
  if (item.format === "date-time") delete item.pattern;
  if (
    Array.isArray(item.anyOf) &&
    item.anyOf.some((choice: any) => choice.format === "date-time") &&
    item.anyOf.some((choice: any) => choice.type === "null")
  )
    item.anyOf.sort(
      (left: any, right: any) =>
        Number(left.type !== "null") - Number(right.type !== "null"),
    );
  Object.values(item).forEach(normalize);
}
normalize(schema);
const file = fileURLToPath(new URL("../openapi.yaml", import.meta.url));
const current = readFileSync(file, "utf8");
const replacement =
  "    ConnectUniversalCardsPayload: " + JSON.stringify(schema) + "\n";
const marker = /^    ConnectUniversalCardsPayload: .*\n/m;
const next = marker.test(current)
  ? current.replace(marker, () => replacement)
  : current + replacement;
let result = next;
for (const [name, source] of Object.entries({
  ConnectFinancialReceipt: ConnectFinancialReceiptSchema,
  ConnectPartnerReport: ConnectPartnerReportSchema,
  ConnectExternalTransaction: ConnectExternalTransactionSchema,
  ConnectPartnerRegistrationInput: ConnectPartnerInput,
  ConnectAgreementProposalInput: ConnectAgreementTerms,
  ConnectAgreementAcceptanceInput: ConnectAgreementAcceptInput,
  ConnectPartnerEventInput: ConnectPartnerEvent,
  ConnectFinanceCommandInput: ConnectFinanceCommand,
  ConnectReferralDisclosure: ConnectReferralDisclosureSchema,
  ConnectOutboundInput: ConnectOutboundInputSchema,
  ConnectSiteRegistrationInput: ConnectSiteInput,
  ConnectIntegrationRegistrationInput: ConnectIntegrationInput,
  ConnectReviewDecisionInput: ConnectReviewInput,
  ConnectCatalogImportInput: ConnectCatalogBatch,
  ConnectTeamPermissionInput: ConnectTeamInput,
  ConnectSiteLifecycleInput: ConnectSiteCommandInput,
  ConnectCatalogSyncRequest: ConnectCatalogSyncInput,
  ConnectOAuthStatus: ConnectOAuthStatusSchema,
})) {
  const generated = z.toJSONSchema(source);
  delete generated.$schema;
  normalize(generated);
  const entry = `    ${name}: ${JSON.stringify(generated)}\n`;
  const pattern = new RegExp(`^    ${name}: .*\\n`, "m");
  result = pattern.test(result)
    ? result.replace(pattern, () => entry)
    : result + entry;
}
if (result !== current) writeFileSync(file, result);
