FROM oven/bun:1.4.2 AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile --ignore-scripts
RUN mkdir /runtime && cp -aL packages/protocol/node_modules/zod /runtime/zod && rm packages/protocol/node_modules/zod && ln -s ../../../node_modules/zod packages/protocol/node_modules/zod

FROM oven/bun:1.4.2
WORKDIR /app
ARG AI_CODE_COMMIT=source-archive
ENV AI_CODE_COMMIT=$AI_CODE_COMMIT AI_DATA_DIR=/data AI_HOST=0.0.0.0 AI_PORT=8090
COPY --from=build --chown=bun:bun /app/apps/shogi-ai /app/apps/shogi-ai
COPY --from=build --chown=bun:bun /app/packages/four-shogi /app/packages/four-shogi
COPY --from=build --chown=bun:bun /app/packages/protocol /app/packages/protocol
COPY --from=build --chown=bun:bun /runtime/zod /app/node_modules/zod
RUN mkdir /data && chown bun:bun /data
USER bun
EXPOSE 8090
CMD ["bun", "apps/shogi-ai/src/cli.ts", "serve", "--workers", "5", "--seconds", "86400"]
