import { interpretMarketplaceTurn } from "../src/ai/marketplace-intent";
import { parseStructuredSearch } from "../src/ai/search-query";
import { createInitialSaleDraft } from "../src/ai/listing-draft";
import { TEST_MARKETPLACE_CATEGORY_SCHEMAS } from "./fixtures/marketplace-categories";

const categories = TEST_MARKETPLACE_CATEGORY_SCHEMAS;
const knownCities = ["عمان", "الكويت"];
/** Everything the deterministic marketplace layer derives from one message, as plain JSON. */
export function deterministicReading(message: string) {
  // A new draft's id is a random UUID by design; everything else must be identical.
  return JSON.parse(JSON.stringify({
    turn: interpretMarketplaceTurn(message, { categories, knownCities }),
    followUp: interpretMarketplaceTurn(message, { previous: { search: "", categoryId: "cars", filters: [] } as any, currentResultCount: 3, categories, knownCities }),
    search: parseStructuredSearch(message, undefined, categories, { knownCities }) ?? null,
    draft: createInitialSaleDraft(message, categories as any) ?? null,
  }, (key, value) => (key === "draftId" && typeof value === "string" ? "<random-uuid>" : value)));
}

import { createHash } from "node:crypto";
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** Golden form: full readings for ordinary requests (readable diffs), digests for 2,000-character inputs. */
export function goldenEntry(message: string, legitimate: boolean) {
  const reading = deterministicReading(message);
  return legitimate ? reading : { sha256: digest(reading) };
}
export const goldenKey = (message: string) => createHash("sha256").update(message).digest("hex").slice(0, 16);
