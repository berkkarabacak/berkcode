# Web version: running Claude Agent Runner on a server

The same app as on Windows, started in **server mode** (`RUNNER_SERVER=1`): it runs on a server, everybody opens it
at one address (here `https://agents.berkkarabacak.com`) and signs in with one shared password. Features that only
make sense on someone's own Windows computer (folder picker, "Start with Windows", the icon next to the clock,
opening folders in Explorer, sharing a ZIP) are switched off; "Open website" becomes a preview in the browser and
"Open folder" a ZIP download.

## How it is set up

- **One Docker container**, `agent-runner`, built from the `Dockerfile` in this repository. It listens only on the
  host's `127.0.0.1:4280`. **nginx** in front of it does HTTPS (certificate from certbot, like the other sites).
- **All data in `/var/lib/agent-runner`** on the host:
  - `app/`: the database `app.db` (projects, chats, memory, settings, the Claude API key), its daily copies in
    `app/db-backups/`, restore points, logs, and at first the sign-in password file `app/initial-password.txt`;
  - `projects/`: the project folders the agents work in;
  - `home/`: the agents' home: Kimi's login and sessions, npm and git settings.
- **Limits** keep a shared server responsive: at most 1 CPU at low priority, 1.5 GB of memory without swap, 512
  processes. The container runs as an unprivileged user (uid 10001) without extra capabilities; the app's own code is
  read-only for it. It cannot see the host's files or the services the host only offers on `127.0.0.1`.

## Before the first installation

1. **DNS**: an A record `agents.berkkarabacak.com` pointing at the server (added by Berk at the domain registrar).
   Check: `dig +short agents.berkkarabacak.com` prints the server's IP address.
2. **On the server**: Docker, nginx, certbot (webroot `/var/www/certbot`), git and curl; port 4280 free on
   `127.0.0.1` (`ss -ltn | grep ':4280 '` prints nothing); about 3 GB of free disk.

## First installation (as root)

1. **Code**: `git clone https://github.com/berkkarabacak/berkcode.git /opt/agent-runner`
2. **Build and start**: `/opt/agent-runner/deploy/run.sh`
   The first build takes a few minutes (it downloads the Node.js image, the npm packages and Kimi Code CLI) and uses
   up to two CPUs for that time, so start it while the server is quiet. The script ends with `OK: {...}` when the app
   answers, and tells you where the sign-in password file is.
3. **Check the container**:
   - `docker ps --filter name=agent-runner`: after about 40 seconds the status says `(healthy)`;
   - `docker logs --tail 20 agent-runner`: ends with `... is running at http://127.0.0.1:4280`;
   - `docker stats --no-stream agent-runner`: the memory limit shows `1.5GiB`. If Docker printed a warning that limits
     are not supported, or the limit is missing, stop here and report it.
4. **nginx, step 1** (for the certificate): copy `deploy/nginx/agents.berkkarabacak.com.http-only.conf` to
   `/etc/nginx/sites-available/agents.berkkarabacak.com`, link it into `/etc/nginx/sites-enabled/`, then
   `nginx -t && systemctl reload nginx`.
5. **Certificate**: `certbot certonly --webroot -w /var/www/certbot -d agents.berkkarabacak.com`
   It renews automatically, like the other sites' certificates.
6. **nginx, step 2**: replace that file with `deploy/nginx/agents.berkkarabacak.com.conf` (match its TLS lines to the
   other sites on the server), then `nginx -t && systemctl reload nginx`.
7. **Test from outside the server** (on the server itself use `curl --resolve agents.berkkarabacak.com:443:127.0.0.1`):
   - `curl -sI https://agents.berkkarabacak.com/` answers `302` with `location: /login`;
   - `curl -s https://agents.berkkarabacak.com/login | grep -c 'Enter the password you were given'` prints `1`;
   - `curl -s -o /dev/null -w '%{http_code}\n' https://agents.berkkarabacak.com/api/projects` prints `401`;
   - `curl -s -o /dev/null -w '%{http_code}\n' -X POST https://agents.berkkarabacak.com/mcp/x` prints `404`.
8. **The sign-in password** was made at the first start and is in `/var/lib/agent-runner/app/initial-password.txt`
   (readable only by root and the container). Never print it into logs, chats or issues. Berk reads it himself, signs
   in, and can change it in Settings → Sign-in password (the file is deleted then).
9. **Claude**: Berk signs in and enters the Claude API key in Settings → Claude API key → Test key.
10. **Kimi**: `docker exec -it agent-runner kimi login` shows a web address and a code; Berk confirms the code with his
    Kimi account (on his phone is fine). Then, in the app: Settings → Kimi Code CLI → Check again.

## Updating

```
cd /opt/agent-runner && git pull && deploy/run.sh
```

It builds the new version, stops the old container gracefully (active agent runs are stopped and recorded, waiting
chat messages are kept) and starts the new one. The data stays. Newer versions upgrade the database by themselves
and only ever add tables and columns, so going back to an older version keeps working.

**Rollback**: `git log --oneline -5`, then `git checkout <commit> && deploy/run.sh`. Back to the newest version:
`git checkout main && git pull && deploy/run.sh`.

## Backups

Everything is in `/var/lib/agent-runner`. The app also copies its database once a day to `app/db-backups/` (the last
7 are kept). Include the whole folder in the server's backups; for a consistent copy while the app runs, use the newest
file in `app/db-backups/` for the database, or stop the container first (`docker stop agent-runner`).

## Everyday administration

| What | How |
| --- | --- |
| Logs | `docker logs --tail 100 agent-runner` |
| Restart | `docker restart agent-runner`, or Settings → Restart app |
| A new password (signs everybody out) | `docker exec agent-runner node src/cli.js new-password` (saved in `app/initial-password.txt`), or choose one: `docker exec -it agent-runner node src/cli.js set-password` |
| Kimi logged out | `docker exec -it agent-runner kimi login` |
| Stop | `docker stop agent-runner` (it stays stopped until `docker start agent-runner`) |
| Remove completely | `docker rm -f agent-runner`, remove the nginx site and `certbot delete --cert-name agents.berkkarabacak.com`, then delete `/var/lib/agent-runner` (all projects and their history!) |

## Security, in short

- The agents run commands inside the container: that is how they build things. The container cannot reach the host's
  files or its `127.0.0.1` services, runs unprivileged, and cannot change the app's code.
- Everybody with the password uses the shared Claude key and Kimi subscription. Each Claude run has a budget limit and
  there is a monthly cap in Settings; a monthly spend limit in the Claude Console caps the total as well.
- Wrong passwords are limited (8 per address per 15 minutes, 100 overall). A signed-in browser stays signed in for 30
  days while it is used; changing the password signs everybody else out. The session cookie is `HttpOnly`, `Secure`
  and `SameSite=Lax`, and the API refuses requests from other websites.
- Project websites are previewed in a sandbox (an origin of their own), so pages written by an agent cannot act in the
  app. The agents' memory addresses (`/mcp/...`) only answer inside the container, and nginx does not pass them on.
