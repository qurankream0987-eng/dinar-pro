import { ConnectCatalogBatch } from "@workspace/api-zod/connect-platform";
import { connectError } from "./provider-registry";
/** Shared untrusted provider document boundary; no text/tool interpretation. */
export function parseBoundedConnectProviderJson(text: string) {
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { throw connectError(502, "PROVIDER_INVALID_CATALOG", "كتالوج المزوّد ليس JSON صالحًا"); }
  let entries = 0;
  const bounded = (value: unknown, depth = 0): void => {
    if (depth > 12 || ++entries > 5000) throw connectError(502, "PROVIDER_INVALID_CATALOG", "كتالوج المزوّد يتجاوز حدود البنية");
    if (Array.isArray(value)) { if (value.length > 100) throw connectError(502, "PROVIDER_INVALID_CATALOG", "عدد عناصر المزوّد يتجاوز حد الدفعة"); value.forEach(item => bounded(item, depth + 1)); }
    else if (value && typeof value === "object") Object.values(value).forEach(item => bounded(item, depth + 1));
  };
  bounded(parsed);
  return parsed;
}
export function parseConnectCatalogDocument(text: string) {
  const parsed = parseBoundedConnectProviderJson(text);
  const result = ConnectCatalogBatch.safeParse(parsed);
  if (!result.success) throw connectError(502, "PROVIDER_INVALID_CATALOG", "حقول كتالوج المزوّد لا تطابق العقد المعتمد؛ لم يُستورد شيء");
  return result.data;
}
