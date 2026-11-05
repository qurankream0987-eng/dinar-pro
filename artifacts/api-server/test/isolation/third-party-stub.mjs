// Local stand-in for the third-party origins the web app loads at runtime: the Google Fonts
// stylesheet in artifacts/dinar/index.html, and the sample photos of the development seed
// (images.unsplash.com, src/lib/dinar-data.ts). Inside the sandbox the real hosts are
// unreachable, and the browser suites assert a clean console, so the sandbox's Chromium resolves
// those hosts here (--host-resolver-rules) and receives an empty stylesheet or a 1×1 transparent
// PNG. Every request is logged, so the evidence shows exactly what was stubbed.
import { appendFileSync, readFileSync } from "node:fs";
import https from "node:https";

const TRANSPARENT_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const [certFile, keyFile, port, log] = process.argv.slice(2);
https
  .createServer({ cert: readFileSync(certFile), key: readFileSync(keyFile) }, (req, res) => {
    appendFileSync(log, `${JSON.stringify({ host: req.headers.host, path: req.url?.split("?")[0] })}\n`);
    if (req.headers.host === "browser.catalog.partner.example" && req.url?.startsWith("/oauth/authorize?")) {
      const query = new URL(req.url, "https://browser.catalog.partner.example").searchParams;
      let callback;
      try { callback = new URL(query.get("redirect_uri")); } catch { res.writeHead(400); res.end(); return; }
      if (callback.protocol !== "http:" || callback.hostname !== "127.0.0.1" || !callback.port || callback.pathname !== "/api/connect/oauth/callback" || callback.search || callback.hash || callback.username || callback.password ||
          query.get("scope") !== "catalog.read" || query.get("client_id") !== "browser-public-client" || query.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(query.get("state") ?? "") || !/^[A-Za-z0-9_-]{43}$/.test(query.get("code_challenge") ?? "")) {
        res.writeHead(400); res.end(); return;
      }
      callback.searchParams.set("state", query.get("state")); callback.searchParams.set("code", "browser-synthetic-code");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Referrer-Policy": "no-referrer", "Cache-Control": "no-store", "X-Dinar-Test-Fixture": "oauth-public-client-only" });
      res.end(`<!doctype html><html lang="ar" dir="rtl"><title>Isolated read-only OAuth provider</title><p>مزود اصطناعي معزول؛ لا حساب حي ولا صلاحية دفع.</p><a href="${callback.href.replaceAll("&", "&amp;")}">الموافقة على قراءة الكتالوج فقط</a></html>`);
      return;
    }
    if (["dash.cloudflare.com","browser.catalog.partner.example"].includes(req.headers.host)) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "X-Dinar-Test-Fixture": "provider-navigation-only" });
      res.end("<!doctype html><title>Isolated provider navigation fixture</title><p>Public destination fixture only; no provider availability, pricing or checkout evidence.</p>");
      return;
    }
    if (/^images\./u.test(req.headers.host ?? "")) {
      res.writeHead(200, { "Content-Type": "image/png", "Access-Control-Allow-Origin": "*" });
      res.end(TRANSPARENT_PNG);
      return;
    }
    res.writeHead(200, { "Content-Type": "text/css", "Access-Control-Allow-Origin": "*" });
    res.end("/* sandbox stub: third-party font stylesheet */\n");
  })
  .listen(Number(port), "127.0.0.1", () => console.log("THIRD_PARTY_STUB: listening"));
