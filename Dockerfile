# Claude Agent Runner, web version (server mode). See deploy/README.md.
# Everything that must survive an update lives in the /data volume: the app's database and backups, the projects,
# and the agents' home (Kimi's login and sessions, npm and git settings). The app's code is read-only for the app.
FROM node:24-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git ripgrep procps tini \
 && rm -rf /var/lib/apt/lists/*

# Kimi Code CLI with its official installer (glibc build) into /opt/kimi-code; its login lives in the volume.
RUN curl -fsSL https://code.kimi.com/kimi-code/install.sh | KIMI_INSTALL_DIR=/opt/kimi-code KIMI_NO_MODIFY_PATH=1 bash \
 && /opt/kimi-code/bin/kimi --version

# The app runs as an unprivileged user with its home in the volume (uid 10001: no user of that number on the host).
RUN groupadd --gid 10001 runner && useradd --uid 10001 --gid runner --home-dir /data/home --no-create-home --shell /bin/bash runner

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY . .

ENV NODE_ENV=production \
    RUNNER_SERVER=1 \
    RUNNER_HOST=0.0.0.0 \
    RUNNER_DATA_DIR=/data/app \
    RUNNER_PROJECTS_DIR=/data/projects \
    HOME=/data/home \
    PATH=/opt/kimi-code/bin:$PATH \
    KIMI_CODE_NO_AUTO_UPDATE=1

USER runner
EXPOSE 4280
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4280/api/ping').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/server.js", "--port=4280"]
