#!/usr/bin/env bash
# Builds the Claude Agent Runner image and (re)starts its container. Run as root:
#   /opt/agent-runner/deploy/run.sh
# Run it again for every update: the data stays in /var/lib/agent-runner, and running agent work is stopped and
# recorded before the old container goes. Settings can be changed with environment variables (see below).
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NAME="${NAME:-agent-runner}"
IMAGE="${IMAGE:-claude-agent-runner:latest}"
DATA="${DATA:-/var/lib/agent-runner}"
PORT="${PORT:-4280}"
PUBLIC_URL="${PUBLIC_URL:-https://agents.berkkarabacak.com}"
TZ_NAME="${TZ_NAME:-Europe/Istanbul}"

echo "== Building $IMAGE from $APP_DIR"
docker build --pull -t "$IMAGE" "$APP_DIR"

echo "== Data folder $DATA (owned by the container's user 10001, private)"
install -d -m 700 -o 10001 -g 10001 "$DATA"

if docker container inspect "$NAME" >/dev/null 2>&1; then
  echo "== Stopping the old container (active agent runs are stopped and recorded)"
  docker stop -t 40 "$NAME" >/dev/null || true
  docker rm "$NAME" >/dev/null
fi

echo "== Starting $NAME on 127.0.0.1:$PORT"
# Limits keep a shared server responsive: at most 1 CPU at low priority, 1.5 GB of memory without swap.
docker run -d --name "$NAME" --restart unless-stopped \
  -e RUNNER_PUBLIC_URL="$PUBLIC_URL" -e TZ="$TZ_NAME" \
  -p "127.0.0.1:$PORT:4280" \
  -v "$DATA:/data" \
  --cpus 1 --cpu-shares 256 --memory 1536m --memory-swap 1536m --pids-limit 512 \
  --security-opt no-new-privileges --cap-drop ALL \
  --log-opt max-size=10m --log-opt max-file=3 \
  "$IMAGE" >/dev/null

echo "== Waiting for the app"
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/api/ping" >/dev/null 2>&1; then
    echo "OK: $(curl -fsS "http://127.0.0.1:$PORT/api/ping")"
    if [ -f "$DATA/app/initial-password.txt" ]; then
      echo "The sign-in password is in $DATA/app/initial-password.txt (never print it into logs or chats)."
    fi
    exit 0
  fi
  sleep 2
done
echo "The app did not answer in time. See: docker logs --tail 50 $NAME" >&2
exit 1
