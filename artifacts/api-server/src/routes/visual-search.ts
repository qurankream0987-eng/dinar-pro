import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../lib/auth";
import { ObjectStorageService } from "../lib/objectStorage";
import {
  completeVisualSearchUpload,
  isOwnedVisualSearchPath,
  visualSearchObjectName,
} from "../lib/visual-search-images";

const UploadBody = z.object({ contentType: z.string().max(40), size: z.number().int() }).strict();
const PathBody = z.object({ objectPath: z.string().max(300) }).strict();

/** Buyers' private photo search. Separate from /account/listing-photos by path, ACL and route. */
/** Search itself happens in the conversation turn (routes/ai.ts), through the one runtime. */
export function createVisualSearchRouter() {
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

  return router;
}

export default createVisualSearchRouter();
