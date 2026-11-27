#!/usr/bin/env bash
# CI: checks how the web version's container runs (started by deploy/run.sh as "agent-runner"), then runs a whole chat
# inside the same image with the test stand-in for Kimi (test/fixtures/fake-kimi.mjs).
set -uo pipefail
failed=0
check() {
  if [ "$3" = "$2" ]; then
    echo "OK    $1"
  else
    echo "FAIL  $1 (expected $2, got $3)"
    failed=$((failed + 1))
  fi
}
yes_if() { if "$@" >/dev/null 2>&1; then echo yes; else echo no; fi; }

echo "== How the container runs"
check "it runs as the unprivileged user 10001" 10001 "$(docker exec agent-runner id -u)"
check "memory limit 1.5 GB" 1610612736 "$(docker inspect -f '{{.HostConfig.Memory}}' agent-runner)"
check "no swap on top" 1610612736 "$(docker inspect -f '{{.HostConfig.MemorySwap}}' agent-runner)"
check "CPU limit 1" 1000000000 "$(docker inspect -f '{{.HostConfig.NanoCpus}}' agent-runner)"
check "no extra privileges" '[ALL]' "$(docker inspect -f '{{.HostConfig.CapDrop}}' agent-runner)"
check "published on the host's 127.0.0.1 only" 127.0.0.1 "$(docker inspect -f '{{(index (index .HostConfig.PortBindings "4280/tcp") 0).HostIp}}' agent-runner)"
check "the app's code is read-only for it" no "$(yes_if docker exec agent-runner touch /app/probe)"
check "Kimi Code CLI is installed" yes "$(yes_if docker exec agent-runner kimi --version)"
check "Claude's engine for Linux is installed" yes "$(yes_if docker exec -w /app agent-runner node -e "require.resolve('@anthropic-ai/claude-agent-sdk-linux-x64/package.json')")"
for _ in $(seq 1 45); do [ "$(docker inspect -f '{{.State.Health.Status}}' agent-runner)" = healthy ] && break; sleep 2; done
check "Docker's health check reports healthy" healthy "$(docker inspect -f '{{.State.Health.Status}}' agent-runner)"
inside="$(docker exec agent-runner node -e "fetch('http://127.0.0.1:4280/mcp/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then(async (r) => console.log(r.status, await r.text()))")"
check "the memory service answers agents inside the container" yes "$(case "$inside" in *'not valid'*) echo yes ;; *) echo no ;; esac)"

echo "== A whole chat inside the image (stand-in for Kimi)"
data="$(mktemp -d)"
mkdir -p "$data/fake"
sudo chown -R 10001:10001 "$data"
docker run -d --name agent-runner-e2e -p 127.0.0.1:4281:4280 -v "$data:/data" -v "$PWD/test/fixtures:/fake:ro" \
  -e RUNNER_PUBLIC_URL=https://agents.example.test -e RUNNER_KIMI_COMMAND='["node","/fake/fake-kimi.mjs"]' \
  -e FAKE_KIMI_STATE=/data/fake -e RUNNER_KIMI_QUIET_MS=800 claude-agent-runner:latest >/dev/null
base=http://127.0.0.1:4281
for _ in $(seq 1 30); do curl -fs "$base/api/ping" >/dev/null && break; sleep 1; done
password_json="$(sudo python3 -c 'import json, sys; print(json.dumps({"password": open(sys.argv[1]).read().strip()}))' "$data/app/initial-password.txt")"
cookie="$(printf '%s' "$password_json" | curl -s -D - -o /dev/null -H 'Content-Type: application/json' --data-binary @- "$base/api/login" | awk 'tolower($1) == "set-cookie:" { print $2 }' | cut -d';' -f1)"
check "signed in" yes "$(case "$cookie" in ar_session=?*) echo yes ;; *) echo no ;; esac)"
api() { curl -s -H "Cookie: $cookie" -H 'Content-Type: application/json' "$@"; }
project="$(api -X POST --data '{"name":"E2E Site","agent":"kimi","brief":"A small test website for the container check.","schedule":{"type":"interval","minutes":60}}' "$base/api/projects")"
id="$(printf '%s' "$project" | jq -r .id)"
folder="$(printf '%s' "$project" | jq -r .folder)"
check "a project was created" yes "$(case "$id" in '' | null) echo no ;; *) echo yes ;; esac)"
check "its folder is in the projects volume" "/data/projects/E2E Site" "$folder"
check "Kimi (stand-in) is ready" true "$(api "$base/api/agents?refresh=1" | jq -r '.kimi.loggedIn')"
run="$(api -X POST --data '{"message":"Please build the home page","new_conversation":true}' "$base/api/projects/$id/chat" | jq -r .runId)"
for _ in $(seq 1 60); do
  [ "$(api "$base/api/projects/$id" | jq -r '.active_run_id')" = null ] && break
  sleep 1
done
check "the chat run finished successfully" success "$(api "$base/api/runs/$run" | jq -r .status)"
check "the agent's reply is in the chat" yes "$(api "$base/api/runs/$run" | jq -r '[.logs[] | select(.type == "assistant") | .content] | join(" ")' | grep -q 'wrote hello.txt' && echo yes || echo no)"
check "the agent wrote its file in the project folder" yes "$(yes_if sudo test -f "$data/projects/E2E Site/hello.txt")"
check "the agent wrote its progress note to memory (through the memory service)" yes "$(api "$base/api/projects/$id/memory" | jq -r '.[] | select(.path == "/memories/progress.md") | .content' | grep -q 'Fake session work' && echo yes || echo no)"
check "a restore point was made before the run" true "$(api "$base/api/runs/$run" | jq -r '.restore_available')"
printf '<h1>Hello from the container</h1>' | sudo tee "$data/projects/E2E Site/index.html" >/dev/null
check "the website preview works" 200 "$(curl -s -o /dev/null -w '%{http_code}' -H "Cookie: $cookie" "$base/preview/$id/")"
check "the preview runs in a sandbox" yes "$(curl -s -D - -o /dev/null -H "Cookie: $cookie" "$base/preview/$id/" | grep -qi '^content-security-policy: sandbox' && echo yes || echo no)"
check "the project downloads as a ZIP" application/zip "$(curl -s -o /dev/null -w '%{content_type}' -H "Cookie: $cookie" "$base/api/projects/$id/download")"
docker rm -f agent-runner-e2e >/dev/null

echo
if [ "$failed" -eq 0 ]; then echo "All container checks passed."; else echo "$failed container check(s) failed."; fi
exit "$failed"
