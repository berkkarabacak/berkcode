#!/usr/bin/env bash
# Checks the web version of Claude Agent Runner from the outside, without changing anything in it (it signs in and
# out once, and never prints the password).
#   /opt/agent-runner/deploy/smoke-test.sh                                        the container on this server, as root
#   BASE=https://agents.berkkarabacak.com /opt/agent-runner/deploy/smoke-test.sh  the public address
# Prints one line per check and exits with the number of failed checks (0: everything works).
set -uo pipefail

BASE="${BASE:-http://127.0.0.1:4280}"
HOST_HEADER="${HOST_HEADER:-}"
PASSWORD_FILE="${PASSWORD_FILE:-/var/lib/agent-runner/app/initial-password.txt}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
body="$work/body"
headers="$work/headers"
failed=0

# req METHOD PATH [curl options]: prints the HTTP status; the body and headers land in $body and $headers.
req() {
  local method="$1" path="$2"
  shift 2
  local args=(-s -o "$body" -D "$headers" -w '%{http_code}' -X "$method")
  if [ -n "$HOST_HEADER" ]; then args+=(-H "Host: $HOST_HEADER" -H "X-Forwarded-Proto: https"); fi
  curl "${args[@]}" "$@" "$BASE$path" || echo 000
}
check() {
  if [ "$3" = "$2" ]; then
    echo "OK    $1"
  else
    echo "FAIL  $1 (expected $2, got $3)"
    failed=$((failed + 1))
  fi
}
has() { grep -q -- "$1" "$2" && echo yes || echo no; }
header() { awk -v name="$1" 'tolower($1) == tolower(name) ":" { sub(/\r$/, ""); print $2 }' "$headers" | tail -1; }

echo "Checking $BASE"
check "the health check answers" 200 "$(req GET /api/ping)"
check "the health check names the app" yes "$(has '"claude-agent-runner"' "$body")"
check "the health check reveals nothing about the server" no "$(has '"root"' "$body")"
check "the app asks visitors to sign in first" 302 "$(req GET /)"
check "... on the sign-in page" /login "$(header location)"
check "the sign-in page loads" 200 "$(req GET /login)"
check "the sign-in page shows its text" yes "$(has 'Enter the password you were given' "$body")"
check "the API is locked without signing in" 401 "$(req GET /api/projects)"
check "live updates are locked without signing in" 401 "$(req GET /api/events)"
check "the agents' memory service does not answer from outside" 404 "$(req POST /mcp/x)"
check "a wrong password is refused" 401 "$(req POST /api/login -H 'Content-Type: application/json' --data '{"password":"definitely not the password"}')"

if [ -r "$PASSWORD_FILE" ]; then
  # The password goes to curl through a pipe, so it never shows up in the list of running programs.
  status="$(python3 -c 'import json, sys; print(json.dumps({"password": open(sys.argv[1]).read().strip()}))' "$PASSWORD_FILE" \
    | req POST /api/login -H 'Content-Type: application/json' --data-binary @-)"
  check "the right password signs in" 200 "$status"
  cookie="$(header set-cookie | cut -d';' -f1)"
  check "signing in gives a session cookie" yes "$(case "$cookie" in ar_session=?*) echo yes ;; *) echo no ;; esac)"
  check "the session cookie is HttpOnly and Secure" yes "$(grep -i '^set-cookie:' "$headers" | grep -qi 'httponly' && grep -i '^set-cookie:' "$headers" | grep -qi 'secure' && echo yes || echo no)"
  check "signed in, the API works" 200 "$(req GET /api/state -H "Cookie: $cookie")"
  check "the app runs as the web version" yes "$(has '"server_mode":true' "$body")"
  check "signed in, the app's page loads" 200 "$(req GET / -H "Cookie: $cookie")"
  check "signing out works" 200 "$(req POST /api/logout -H "Cookie: $cookie")"
  check "after signing out the session is over" 401 "$(req GET /api/projects -H "Cookie: $cookie")"
else
  echo "SKIP  signing in: $PASSWORD_FILE cannot be read here (run as root on the server, or set PASSWORD_FILE)"
fi

echo
if [ "$failed" -eq 0 ]; then echo "All checks passed."; else echo "$failed check(s) failed."; fi
exit "$failed"
