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
    if (req.headers.host === "dash.cloudflare.com") {
      res.writeHead(200, { "Content-Type": "text/html", "X-Dinar-Test-Fixture": "provider-navigation-only" });
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
