FROM node:24-bookworm-slim

ARG PNPM_VERSION=10.26.1

WORKDIR /app

# Optional managed-cloud trust is mounted for this step only; ordinary CI uses its
# existing system roots. Never copy a session CA or disable TLS verification.
RUN --mount=type=secret,id=proxy_ca \
  set -eu; \
  if [ -s /run/secrets/proxy_ca ]; then \
    export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca NODE_USE_ENV_PROXY=1; \
  fi; \
  corepack enable \
  && corepack prepare "pnpm@${PNPM_VERSION}" --activate

# Keep dependency installation cached when application source changes. Keep this manifest list in
# sync with the workspace packages in pnpm-workspace.yaml.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY artifacts/api-server/package.json artifacts/api-server/package.json
COPY artifacts/dinar/package.json artifacts/dinar/package.json
COPY artifacts/mockup-sandbox/package.json artifacts/mockup-sandbox/package.json
COPY lib/api-client-react/package.json lib/api-client-react/package.json
COPY lib/api-spec/package.json lib/api-spec/package.json
COPY lib/api-zod/package.json lib/api-zod/package.json
COPY lib/db/package.json lib/db/package.json
COPY lib/global/package.json lib/global/package.json
COPY lib/integrations-openai-ai-server/package.json lib/integrations-openai-ai-server/package.json
COPY scripts/package.json scripts/package.json

RUN --mount=type=secret,id=proxy_ca \
  set -eu; \
  if [ -s /run/secrets/proxy_ca ]; then \
    export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca NODE_USE_ENV_PROXY=1; \
  fi; \
  pnpm install --frozen-lockfile

COPY . .

RUN pnpm --filter @workspace/dinar run build \
  && pnpm --filter @workspace/api-server run build

ENV NODE_ENV=production
ENV DINAR_WEB_DIST=/app/artifacts/dinar/dist/public

# /api/readyz resolves the checked-in migration journal relative to process.cwd().
WORKDIR /app/artifacts/api-server

USER node

CMD ["node", "--enable-source-maps", "/app/artifacts/api-server/dist/index.mjs"]
