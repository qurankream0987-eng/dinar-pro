import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const dockerfile = readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8");

test("runtime dependencies are pruned only after both production artifacts are built", () => {
  const webBuild = dockerfile.indexOf("pnpm --filter @workspace/dinar run build");
  const apiBuild = dockerfile.indexOf("pnpm --filter @workspace/api-server run build");
  const productionInstall = dockerfile.indexOf("pnpm install --prod --frozen-lockfile");
  assert.ok(webBuild >= 0 && apiBuild > webBuild, "frontend and API build before dependency pruning");
  assert.ok(productionInstall > apiBuild, "runtime install follows both builds");
  assert.equal(dockerfile.includes("--no-frozen-lockfile"), false);
});

test("runtime stays non-root and serves the same built frontend/API paths", () => {
  assert.match(dockerfile, /ENV NODE_ENV=production/);
  assert.match(dockerfile, /ENV DINAR_WEB_DIST=\/app\/artifacts\/dinar\/dist\/public/);
  assert.match(dockerfile, /WORKDIR \/app\/artifacts\/api-server/);
  assert.match(dockerfile, /USER node/);
  assert.match(dockerfile, /dist\/index\.mjs/);
});
