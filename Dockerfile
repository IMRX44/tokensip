# Override to use a registry mirror, e.g. --build-arg NODE_IMAGE=mirror.gcr.io/library/node:24-alpine
ARG NODE_IMAGE=node:24-alpine

# ---------------------------------------------------------------- build
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN npm ci --ignore-scripts
COPY tsconfig.base.json ./
COPY packages ./packages
RUN npm run build

# ---------------------------------------------------------------- production dependencies
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN npm ci --omit=dev --ignore-scripts --include-workspace-root=false \
      --workspace=packages/core --workspace=packages/server \
 && rm -rf node_modules/gpt-tokenizer/dist node_modules/gpt-tokenizer/cjs \
           node_modules/gpt-tokenizer/src node_modules/gpt-tokenizer/data \
 && find node_modules \( -name "*.map" -o -name "*.d.ts" -o -name "*.md" \) -type f -delete

# ---------------------------------------------------------------- runtime
FROM ${NODE_IMAGE}
LABEL org.opencontainers.image.title="TokenSip" \
      org.opencontainers.image.description="The token-saving AI gateway for OpenAI, Anthropic, Gemini and 20+ providers" \
      org.opencontainers.image.source="https://github.com/IMRX44/tokensip" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production \
    TOKENSIP_MODE=server \
    TOKENSIP_HOST=0.0.0.0 \
    TOKENSIP_PORT=8787 \
    TOKENSIP_DATA_DIR=/data

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/packages/core/package.json ./packages/core/
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/packages/server/package.json ./packages/server/
COPY --from=build /app/packages/server/dist ./packages/server/dist
COPY --from=build /app/packages/server/web ./packages/server/web

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.TOKENSIP_PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "packages/server/dist/cli.js"]
CMD ["start"]
