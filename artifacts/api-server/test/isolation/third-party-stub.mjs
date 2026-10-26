// Local stand-in for the one third-party origin the web app loads at runtime: the Google Fonts
// stylesheet in artifacts/dinar/index.html. Inside the sandbox the real host is unreachable,
// and the browser suites assert a clean console, so the sandbox's Chromium resolves
// fonts.googleapis.com / fonts.gstatic.com here (see chromium-wrapper.sh) and receives an
// empty stylesheet. Every request is logged, so the evidence shows exactly what was stubbed.
import { appendFileSync, readFileSync } from "node:fs";
import https from "node:https";

const [certFile, keyFile, port, log] = process.argv.slice(2);
https
  .createServer({ cert: readFileSync(certFile), key: readFileSync(keyFile) }, (req, res) => {
    appendFileSync(log, `${JSON.stringify({ host: req.headers.host, path: req.url?.split("?")[0] })}\n`);
    res.writeHead(200, { "Content-Type": "text/css", "Access-Control-Allow-Origin": "*" });
    res.end("/* sandbox stub: third-party font stylesheet */\n");
  })
  .listen(Number(port), "127.0.0.1", () => console.log("THIRD_PARTY_STUB: listening"));
