import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { validateAcceptanceDatabase } from './acceptance-database-guard.mjs';
const entry = process.argv[2] || 'commerce.test';
// Inside an isolation session (test/isolation/sandbox.sh) every suite is preflighted first.
if (process.env.DINAR_ISOLATION_SESSION !== undefined) await (await import('./isolation/preflight.mjs')).runIsolationPreflight();
validateAcceptanceDatabase();
mkdirSync('.test-build', { recursive: true });
await build({ entryPoints: [`test/${entry}.ts`], bundle: true, platform: 'node', format: 'esm', outfile: `.test-build/${entry}.mjs`, external: ['pg-native', 'pino', 'pino-http'], logLevel: 'warning', banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
// Opt-in log privacy scan: the suite writes its fixture sentinels to a file; everything the process
// prints (server logs included) is captured and must contain none of them.
const sentinelFile = process.env.BDINAR_LOG_SCAN === '1' ? `.test-build/${entry}.log-sentinels.json` : undefined;
if (sentinelFile) rmSync(sentinelFile, { force: true });
const child = spawn(process.execPath, [`.test-build/${entry}.mjs`], {
  stdio: ['inherit', sentinelFile ? 'pipe' : 'inherit', sentinelFile ? 'pipe' : 'inherit'],
  env: (() => {
    const isolatedEnv = {
      ...process.env,
      DINAR_AI_MODEL_FALLBACK: "false",
      BDINAR_BLOCK_MODEL_CALLS: "1",
    };
    for (const key of [
      "OPENROUTER_API_KEY",
      "OPENAI_API_KEY",
      "GROQ_API_KEY",
      "AI_INTEGRATIONS_OPENAI_API_KEY",
      "AI_INTEGRATIONS_OPENAI_BASE_URL",
      "ANTHROPIC_API_KEY",
    ])
      delete isolatedEnv[key];
    if (sentinelFile) isolatedEnv.BDINAR_LOG_SENTINELS_FILE = sentinelFile;
    return isolatedEnv;
  })(),
});
const captured = [];
for (const [source, sink] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
  source?.on('data', (chunk) => {
    captured.push(chunk);
    sink.write(chunk);
  });
}
let status = await new Promise((resolve) => child.on('close', (code) => resolve(code ?? 1)));
if (sentinelFile) {
  if (!existsSync(sentinelFile)) {
    console.error('LOG_SCAN failed: the suite did not record its sentinels');
    status ||= 1;
  } else {
    const { coordinates = [], addresses = [], secretHashes, canaries = [] } = JSON.parse(readFileSync(sentinelFile, 'utf8'));
    rmSync(sentinelFile, { force: true });
    const output = Buffer.concat(captured).toString('utf8');
    const occurrences = (values) => values.reduce((sum, value) => sum + output.split(value).length - 1, 0);
    const report = { coordinates: occurrences(coordinates), addresses: occurrences(addresses), bytes: output.length };
    if (secretHashes) {
      // Credential suites record only SHA-256 hashes of their 43-character secrets: every
      // 43-character window of every base64url run in the output is hashed and compared.
      const wanted = new Set(secretHashes);
      let secrets = 0;
      for (const [run] of output.matchAll(/[A-Za-z0-9_-]{43,}/g))
        for (let start = 0; start + 43 <= run.length; start++)
          if (wanted.has(createHash('sha256').update(run.slice(start, start + 43)).digest('hex'))) secrets++;
      Object.assign(report, { secrets, canariesSeen: canaries.filter((canary) => output.includes(canary)).length, canaries: canaries.length });
      if (secrets || !secretHashes.length || report.canariesSeen !== canaries.length || !canaries.length) status ||= 1;
    } else if (!coordinates.length || !addresses.length) status ||= 1;
    console.log('LOG_SCAN', JSON.stringify(report));
    if (report.coordinates || report.addresses) status ||= 1;
  }
}
process.exit(status);
