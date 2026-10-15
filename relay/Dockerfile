# The Afterhours relay. Build from the repository root:
#   docker build -f relay/Dockerfile -t afterhours-relay .
#   docker run -d -p 8787:8787 -v afterhours-relay:/data --restart unless-stopped afterhours-relay
# Put TLS in front (Caddy, a load balancer, Fly.io) and give apps and machines the wss:// address.
# It stores keys, links and connection times in /data; it never sees inside a message.

FROM oven/bun:1.3.3 AS build
WORKDIR /src
COPY package.json bun.lock ./
COPY packages/protocol/package.json packages/protocol/
COPY relay/package.json relay/
RUN bun install --frozen-lockfile --ignore-scripts
COPY packages/protocol packages/protocol
COPY relay relay
RUN bun build relay/src/main.ts --target=bun --outfile=/out/relay.js

FROM oven/bun:1.3.3-slim
RUN mkdir -p /data && chown bun:bun /data
COPY --from=build /out/relay.js /app/relay.js
USER bun
WORKDIR /data
ENV PORT=8787 HOST=0.0.0.0 RELAY_DB=/data/relay.db
EXPOSE 8787
VOLUME /data
HEALTHCHECK --interval=30s --timeout=5s CMD ["bun", "-e", "fetch('http://127.0.0.1:' + process.env.PORT + '/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["bun", "/app/relay.js"]
