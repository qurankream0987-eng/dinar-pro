import { z } from "zod";
import { ConnectCatalogItem } from "@workspace/api-zod/connect-platform";
export const WebsiteCatalogCandidate = ConnectCatalogItem.omit({ sourceVersion: true, sourceCheckedAt: true });
export const WebsiteObservationSchema = z.object({
  id: z.string().uuid(), observedAt: z.string().datetime(), pageDigest: z.string().regex(/^[a-f0-9]{64}$/),
  categoryId: z.string().min(1).max(80), skipped: z.number().int().nonnegative(), items: z.array(WebsiteCatalogCandidate).max(100),
}).strict();
export type WebsiteObservation = z.infer<typeof WebsiteObservationSchema>;
