import express, { type Router } from "express";
import { existsSync, readFileSync } from "node:fs";
import { currentPolicy } from "./policies";
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
  // Public pages that must be readable without JavaScript (Google OAuth branding review,
  // crawlers): the home page, the privacy policy and the terms are sent with their real text
  // inside #root. The app replaces it on mount (createRoot), so the signed-in experience is
  // unchanged; the policy text comes from the same versioned registry as /policies/:key.
  const shellHtml = readFileSync(shell, "utf8");
  // Search engines: only the canonical public host is indexable, and only its public pages for
  // now (listings and storefronts still run on test data). Every other host (staging, the
  // Railway default domain) answers «Disallow: /» so it never competes with the real site.
  router.get("/robots.txt", (req, res) => {
    res.type("text/plain").setHeader("Cache-Control", "public, max-age=3600");
    if (req.hostname !== CANONICAL_HOST) {
      res.send("User-agent: *\nDisallow: /\n");
      return;
    }
    res.send(
      [
        "User-agent: *",
        "Allow: /$",
        "Allow: /privacy$",
        "Allow: /terms$",
        "Allow: /policies",
        "Allow: /assets/",
        "Allow: /brand/",
        "Disallow: /",
        "",
        `Sitemap: https://${CANONICAL_HOST}/sitemap.xml`,
        "",
      ].join("\n"),
    );
  });
  router.get("/sitemap.xml", (req, res) => {
    if (req.hostname !== CANONICAL_HOST) {
      res.status(404).type("text/plain").send("Not found");
      return;
    }
    const updated = currentPolicy("privacy")?.effectiveDate;
    const urls = [
      { path: "/", priority: "1.0" },
      { path: "/privacy", priority: "0.5", lastmod: updated },
      { path: "/terms", priority: "0.5", lastmod: currentPolicy("terms")?.effectiveDate },
      { path: "/policies", priority: "0.3" },
    ];
    res.type("application/xml").setHeader("Cache-Control", "public, max-age=3600");
    res.send(
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
        .map((url) => `  <url><loc>https://${CANONICAL_HOST}${url.path}</loc>${url.lastmod ? `<lastmod>${url.lastmod}</lastmod>` : ""}<priority>${url.priority}</priority></url>`)
        .join("\n")}\n</urlset>\n`,
    );
  });
  router.get(["/", "/privacy", "/terms"], (req, res) => {
    const page = publicPage(req.path);
    res.setHeader("Cache-Control", "no-cache");
    if (!page) return res.sendFile(shell);
    res.type("html").send(
      shellHtml
        .replace(/<title>[^<]*<\/title>/u, `<title>${escapeHtml(page.title)}</title>`)
        .replace('<div id="root"></div>', `<div id="root">${page.body}</div>`),
    );
  });
  // Client-side routes: extension-less GET/HEAD paths get the SPA shell; a missing file
  // (anything with an extension) stays a 404 instead of masquerading as the app.
  router.get(/^\/(?!api(?:\/|$))[^.]*$/, (_req, res) => {
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(shell);
  });
  return router;
}

/** The public production hostname; anything else (staging, *.up.railway.app) is not indexed. */
const CANONICAL_HOST = (process.env.PUBLIC_CANONICAL_HOST ?? "jassimai.com").trim().toLowerCase();

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/gu, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

const LEGAL_LINKS = '<nav aria-label="روابط قانونية"><a href="/privacy">سياسة الخصوصية</a> · <a href="/terms">شروط الاستخدام</a> · <a href="/policies">كل السياسات</a></nav>';

/** Server-rendered text for the public pages; only fixed copy and the published policy registry. */
export function publicPage(pathname: string): { title: string; body: string } | undefined {
  if (pathname === "/") {
    return {
      title: "JassimAI — جاسم، مساعدك الذكي",
      body: [
        '<main dir="rtl" lang="ar">',
        "<h1>JassimAI — جاسم، مساعدك الذكي</h1>",
        "<p>جاسم مساعد ذكي بالعربية يجيب عن أسئلتك العامة، ويساعدك في البيع والشراء داخل سوق JassimAI: تصف ما تريد بيعه فيجهّز لك إعلانًا تراجعه قبل نشره، وتبحث عمّا تريد شراءه فيعرض لك العروض المنشورة ويقارن بينها.</p>",
        "<ul>",
        "<li>محادثة عامة بالعربية الفصحى واللهجات.</li>",
        "<li>البيع: مسودة إعلان من كلامك، لا تُنشر إلا بعد تأكيدك.</li>",
        "<li>الشراء: بحث ومقارنة وسلة، ولا يُنشأ طلب إلا بعد مراجعتك.</li>",
        "<li>للتجار: إدارة المنتجات والطلبات وأرقام المبيعات من سجلاتك.</li>",
        "</ul>",
        "<p>في النسخة الحالية يتم الدفع مباشرة بين المشتري والبائع، ولا يجمع JassimAI المدفوعات.</p>",
        '<p><a href="/login">تسجيل الدخول</a> · <a href="/register">إنشاء حساب</a></p>',
        LEGAL_LINKS,
        "</main>",
      ].join(""),
    };
  }
  const key = pathname === "/privacy" ? "privacy" : pathname === "/terms" ? "terms" : undefined;
  const policy = key ? currentPolicy(key) : undefined;
  if (!policy) return undefined;
  return {
    title: `${policy.titleAr} — JassimAI`,
    body: [
      '<main dir="rtl" lang="ar">',
      `<h1>${escapeHtml(policy.titleAr)}</h1>`,
      `<p>${escapeHtml(policy.summaryAr)}</p>`,
      `<p>النسخة ${escapeHtml(policy.version)} — سارية من ${escapeHtml(policy.effectiveDate)}</p>`,
      ...policy.sections.map((section) => `<section><h2>${escapeHtml(section.heading)}</h2><p>${escapeHtml(section.body)}</p></section>`),
      '<p><a href="/">الصفحة الرئيسية</a></p>',
      LEGAL_LINKS,
      "</main>",
    ].join(""),
  };
}
