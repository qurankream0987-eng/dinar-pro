import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../lib/auth";
import { marketFor } from "../lib/markets";
import { ObjectStorageService } from "../lib/objectStorage";
import { searchMarketplaceListings } from "../lib/marketplace-listings";
import {
  completeVisualSearchUpload,
  isOwnedVisualSearchPath,
  loadVisualSearchImage,
  visualSearchObjectName,
} from "../lib/visual-search-images";
import { createVisualAnalyzer, rankVisualMatches, visualSearchTerms, type VisualAnalyzer } from "../ai/visual-search";

const UploadBody = z.object({ contentType: z.string().max(40), size: z.number().int() }).strict();
const PathBody = z.object({ objectPath: z.string().max(300) }).strict();
const SearchBody = z.object({ objectPath: z.string().max(300), text: z.string().trim().max(500).optional() }).strict();

/** Buyers' private photo search. Separate from /account/listing-photos by path, ACL and route. */
export function createVisualSearchRouter(analyzer: () => VisualAnalyzer = () => createVisualAnalyzer()) {
  const router = Router();
  const storage = new ObjectStorageService();

  router.post("/account/visual-search/upload-url", requireAuth, async (req, res) => {
    const body = UploadBody.parse(req.body);
    const uploadURL = await storage.getObjectEntityUploadURL(visualSearchObjectName(req.actor!.id, body.contentType, body.size));
    const objectPath = storage.normalizeObjectEntityPath(uploadURL);
    if (!isOwnedVisualSearchPath(objectPath, req.actor!.id)) throw new Error("تعذر إنشاء مسار آمن للصورة");
    res.json({ uploadURL, objectPath });
  });

  router.post("/account/visual-search/complete", requireAuth, async (req, res) => {
    const { objectPath } = PathBody.parse(req.body);
    res.json({ objectPath: await completeVisualSearchUpload(objectPath, req.actor!.id, storage) });
  });

  router.post("/account/visual-search/search", requireAuth, async (req, res) => {
    const body = SearchBody.parse(req.body);
    const image = await loadVisualSearchImage(body.objectPath, req.actor!.id, { requireOwnerAccess: true }, storage);
    const result = await analyzer().analyze(image, body.text);
    if (result.status !== "ANALYZED") {
      // Honest fallback: no invented description. Text alone may still search.
      const market = await marketFor(req);
      const listings = body.text ? await searchMarketplaceListings(market, { search: body.text, conversational: true, limit: 12 }) : [];
      res.json({
        status: result.status,
        ...(result.status === "BLOCKED_PROVIDER" ? { reason: result.reason } : {}),
        message: "تعذر تحليل الصورة الآن. صف المنتج بكلمات (النوع، الماركة، اللون) وسأبحث لك.",
        results: listings.map((listing) => ({ listing, match: "SIMILAR" as const })),
      });
      return;
    }
    if (!result.analysis.isProduct) {
      res.json({ status: "NOT_A_PRODUCT", message: "لا تبدو الصورة لمنتج. التقط صورة للمنتج نفسه أو صفه بكلمات.", results: [] });
      return;
    }
    const market = await marketFor(req);
    const listings = await searchMarketplaceListings(market, {
      search: visualSearchTerms(result.analysis, body.text),
      conversational: true,
      limit: 12,
    });
    res.json({
      status: "ANALYZED",
      analysis: result.analysis,
      results: rankVisualMatches(result.analysis, listings.filter((listing) => listing.sellerId !== req.actor!.id)),
    });
  });

  return router;
}

export default createVisualSearchRouter();
