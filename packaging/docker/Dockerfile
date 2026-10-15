# Afterhours in a container: the engine with Claude Code, tmux and git, as a non-root user.
# Build from the repository root:
#   docker build -f packaging/docker/Dockerfile -t afterhours .
# Run it, keeping its home (sign-in, settings, queue, your projects) in a volume:
#   docker run -d --name afterhours --restart unless-stopped -v afterhours:/home/afterhours afterhours
# Then, once:
#   docker exec -it afterhours claude            sign Claude Code in (or pass CLAUDE_CODE_OAUTH_TOKEN, see docs/linux.md)
#   docker exec -it afterhours cq pair --relay wss://relay.example.com
# Projects go in /home/afterhours/projects (clone them there, or mount a folder over it).
# It only makes outbound connections: no ports to publish.

FROM oven/bun:1.3.3 AS build
WORKDIR /src
COPY package.json bun.lock ./
COPY packages/protocol/package.json packages/protocol/
COPY relay/package.json relay/
RUN bun install --frozen-lockfile --ignore-scripts
COPY . .
RUN bun build src/cli/cq.ts --compile --outfile /out/cq

FROM debian:trixie-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends tmux git curl ca-certificates procps openssh-client less \
  && rm -rf /var/lib/apt/lists/*
# Claude Code goes into the image rather than the home volume, so a newer image brings a newer
# version (and it doesn't update itself behind your back).
RUN curl -fsSL https://claude.ai/install.sh | HOME=/opt/claude bash \
  && ln -s "$(readlink -f /opt/claude/.local/bin/claude)" /usr/local/bin/claude \
  && claude --version
COPY --from=build /out/cq /usr/local/bin/cq
RUN useradd --create-home --shell /bin/bash afterhours \
  && mkdir -p /home/afterhours/projects \
  && chown afterhours:afterhours /home/afterhours/projects
USER afterhours
WORKDIR /home/afterhours
ENV LANG=C.UTF-8 DISABLE_AUTOUPDATER=1
VOLUME ["/home/afterhours"]
HEALTHCHECK --interval=60s --timeout=5s CMD curl -fsS http://127.0.0.1:7787/api/health >/dev/null || exit 1
CMD ["cq", "daemon"]
