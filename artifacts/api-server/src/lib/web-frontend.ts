import express, { type Router } from "express";
import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Serves the built web app (artifacts/dinar/dist/public) from the API's own origin, so the
 * relative /api calls, the Origin check on writes and the SameSite=Lax session cookie all
 * see one origin. Enabled only when DINAR_WEB_DIST names that directory; mounted after /api.
 */
export function createWebFrontend(directory: string): Router {
  const root = path.resolve(directory);
  const shell = path.join(root, "index.html");
  if (!existsSync(shell))
    throw new Error("DINAR_WEB_DIST must point at a built web app containing index.html.");

  const router = express.Router();
  router.use(
    express.static(root, {
      index: false,
      dotfiles: "ignore",
      fallthrough: true,
      setHeaders(res, filePath) {
        // Vite emits content-hashed names under assets/; everything else may change per release.
        res.setHeader(
          "Cache-Control",
          path.relative(root, filePath).startsWith(`assets${path.sep}`)
            ? "public, max-age=31536000, immutable"
            : "no-cache",
        );
      },
    }),
  );
  // Client-side routes: extension-less GET/HEAD paths get the SPA shell; a missing file
  // (anything with an extension) stays a 404 instead of masquerading as the app.
  router.get(/^\/(?!api(?:\/|$))[^.]*$/, (_req, res) => {
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(shell);
  });
  return router;
}
