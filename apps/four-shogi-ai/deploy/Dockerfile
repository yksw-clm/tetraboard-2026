ARG SEARCH_IMAGE=tetraboard-four-shogi-search:local
FROM oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS dependencies
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile --production --ignore-scripts --filter '@tetraboard/four-shogi-ai-service'
FROM ${SEARCH_IMAGE}
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=dependencies /app/apps/four-shogi-ai/node_modules ./apps/four-shogi-ai/node_modules
COPY --from=dependencies /app/packages/protocol/node_modules ./packages/protocol/node_modules
COPY packages/four-shogi ./packages/four-shogi
COPY packages/protocol ./packages/protocol
COPY apps/four-shogi-ai ./apps/four-shogi-ai
COPY training/four-shogi-ai ./training/four-shogi-ai
ENV PYTHONDONTWRITEBYTECODE=1
EXPOSE 8790
ENTRYPOINT ["bun", "--no-env-file", "apps/four-shogi-ai/src/main.ts"]
