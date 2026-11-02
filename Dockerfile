FROM node:24-bookworm-slim

ARG PNPM_VERSION=10.26.1

WORKDIR /app

RUN corepack enable \
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

RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm --filter @workspace/dinar run build \
  && pnpm --filter @workspace/api-server run build

ENV NODE_ENV=production
ENV DINAR_WEB_DIST=/app/artifacts/dinar/dist/public

USER node

CMD ["node", "--enable-source-maps", "/app/artifacts/api-server/dist/index.mjs"]
