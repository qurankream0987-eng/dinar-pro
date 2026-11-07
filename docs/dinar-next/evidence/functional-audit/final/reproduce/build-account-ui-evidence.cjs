const fs=require('node:fs');
const path=require('node:path');
const {createRequire}=require('node:module');
const root='/workspace/dinar-next-functional-audit';
const ts=createRequire(path.join(root,'package.json'))('typescript');
const source=fs.readFileSync(path.join(root,'artifacts/api-server/test/api.test.ts'),'utf8');
const ast=ts.createSourceFile('api.test.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
const tests=ast.statements.filter(n=>ts.isExpressionStatement(n)&&ts.isAwaitExpression(n.expression)&&ts.isCallExpression(n.expression.expression)&&n.expression.expression.expression.getText(ast)==='test');
const registration=tests.find(n=>n.getText(ast).includes('A01 verified registration establishes a real session'));
if(!registration)throw new Error('Canonical registration prerequisite not found');
let prefix=source.slice(0,tests[0].getStart(ast));
prefix=prefix.replace('const server = app.listen(0);','const server = app.listen(0, "127.0.0.1");');
prefix=prefix.replace('const storageUploadServer = createServer((req, res) => {',`let permittedBrowserUploadOrigin = "";
const storageUploadServer = createServer((req, res) => {
  if (req.headers.origin) {
    if (req.headers.origin !== permittedBrowserUploadOrigin) { res.writeHead(403).end(); return; }
    res.setHeader("Access-Control-Allow-Origin", permittedBrowserUploadOrigin);
    res.setHeader("Vary", "Origin");
  }
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "PUT");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.writeHead(204).end(); return;
  }`);
const cleanup=ast.statements.find(n=>ts.isExpressionStatement(n)&&ts.isCallExpression(n.expression)&&n.expression.expression.getText(ast)==='after');
if(!cleanup)throw new Error('Canonical cleanup missing');
const extra=`
import { readFile as readStaticUi } from "node:fs/promises";
import { resolve as resolveStaticUi, extname as staticUiExtension } from "node:path";
async function startDinarBrowserTestWeb(_apiTarget: string) {
  const staticRoot = resolveStaticUi(process.cwd(), "../dinar/dist/public");
  const ui = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      let filename = resolveStaticUi(staticRoot, "." + url.pathname);
      if (filename !== staticRoot && !filename.startsWith(staticRoot + "/")) { res.writeHead(403).end(); return; }
      let bytes: Buffer;
      try { bytes = await readStaticUi(filename); } catch { filename = resolveStaticUi(staticRoot, "index.html"); bytes = await readStaticUi(filename); }
      const types: Record<string,string> = { ".html":"text/html", ".js":"application/javascript", ".css":"text/css", ".svg":"image/svg+xml", ".png":"image/png", ".woff2":"font/woff2" };
      res.writeHead(200, { "Content-Type": types[staticUiExtension(filename)] ?? "application/octet-stream" }); res.end(bytes);
    } catch { res.writeHead(500).end(); }
  });
  await new Promise<void>(resolve => ui.listen(0,"127.0.0.1",resolve));
  const address = ui.address(); if (!address || typeof address === "string") throw new Error("Missing fixture UI port");
  return { baseUrl: "http://127.0.0.1:" + address.port, stop: () => new Promise<void>((resolve,reject) => ui.close(error => error ? reject(error) : resolve())) };
}
import { execFile as runAccountBrowser } from "node:child_process";
import { promisify as accountPromisify } from "node:util";
import { readFile as readAccountEvidence } from "node:fs/promises";
await nodeTest("actual profile, avatar upload and password controls persist authorized outcomes", async () => {
  const web = await startDinarBrowserTestWeb(\`http://127.0.0.1:\${port}\`);
  permittedBrowserUploadOrigin = web.baseUrl;
  const reportPath = process.env.DINAR_ACCOUNT_UI_RESULT!;
  try {
    await accountPromisify(runAccountBrowser)(process.execPath, ["/workspace/dinar-connect-evidence/account-ui-evidence.cjs"], {
      env: { ...process.env, ACCOUNT_UI_BASE: web.baseUrl, ACCOUNT_UI_API: base, ACCOUNT_UI_COOKIE: cookie, ACCOUNT_UI_PHONE: phone, ACCOUNT_UI_PASSWORD: password, ACCOUNT_UI_RESULT: reportPath },
      timeout: 180000, maxBuffer: 4 * 1024 * 1024,
    });
    const report = JSON.parse(await readAccountEvidence(reportPath, "utf8"));
    assert.equal(report.failure, undefined);
    assert.deepEqual(report.pageErrors, []);
    assert.deepEqual(report.consoleErrors, []);
    assert.deepEqual(report.externalRequests, []);
    const [saved] = await db.select({ displayName: users.displayName, city: users.city, area: users.area, avatarObjectPath: users.avatarObjectPath }).from(users).where(eq(users.id, buyer.id));
    assert.equal(saved?.displayName, report.profile.displayName);
    assert.equal(saved?.city, report.profile.city);
    assert.equal(saved?.area, report.profile.area);
    assert.equal(saved?.avatarObjectPath, report.avatar.objectPath);
    assert.equal((await request("/auth/me")).data.user, null, "the original browser/API session was revoked by password change");
    assert.equal((await request("/orders")).status, 401);
    const [newActor] = await db.select({ id: users.id, phoneVerified: users.phoneVerified, displayName: users.displayName }).from(users).where(eq(users.id, report.registration.id));
    assert.equal(newActor?.phoneVerified, true);
    assert.equal(newActor?.displayName, report.registration.displayName);
    assert.notEqual(newActor?.id, buyer.id);
    console.log("ACCOUNT_UI_ACTUAL", JSON.stringify({ profileSaved: true, avatarPersisted: true, oldSessionRevoked: true, browser: report }));
  } finally { await web.stop(); }
});
`;
const generated='// Focused fixture reuse from canonical api.test.ts; no application or canonical test source change.\n'+prefix+'\n'+registration.getText(ast)+'\n'+extra+'\n'+cleanup.getText(ast)+'\n';
fs.writeFileSync('/workspace/dinar-connect-evidence/account-ui-evidence-entry.ts',generated);
console.log('Prepared canonical local-storage/registration fixture plus focused actual account browser acceptance.');
