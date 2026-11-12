import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../lib/auth";
import { ObjectStorageService } from "../lib/objectStorage";
import { chatVideoObjectName, completeChatVideoUpload, isOwnedChatVideoPath } from "../lib/chat-video";

const UploadBody = z.object({ contentType: z.string().max(40), size: z.number().int() }).strict();
const PathBody = z.object({ objectPath: z.string().max(300) }).strict();

/** Signed-in users' private chat videos (lib/chat-video.ts). Separate prefix, ACL and route. */
export function createChatVideoRouter() {
  const router = Router();
  const storage = new ObjectStorageService();
  router.post("/account/chat-video/upload-url", requireAuth, async (req, res) => {
    const body = UploadBody.parse(req.body);
    const uploadURL = await storage.getObjectEntityUploadURL(chatVideoObjectName(req.actor!.id, body.contentType, body.size));
    const objectPath = storage.normalizeObjectEntityPath(uploadURL);
    if (!isOwnedChatVideoPath(objectPath, req.actor!.id)) throw new Error("تعذر إنشاء مسار آمن للفيديو");
    res.json({ uploadURL, objectPath });
  });
  router.post("/account/chat-video/complete", requireAuth, async (req, res) => {
    const { objectPath } = PathBody.parse(req.body);
    res.json({ objectPath: await completeChatVideoUpload(objectPath, req.actor!.id, storage) });
  });
  return router;
}

export default createChatVideoRouter();
