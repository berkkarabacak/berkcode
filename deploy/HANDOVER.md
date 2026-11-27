# Claude Agent Runner: putting it online at agents.berkkarabacak.com

For the AI that deploys and runs it: the system manager of Berk's new server. Written on 2026-11-24 by Claude, the
session that built the app. Berk (the owner) is the system manager's boss: his word decides. I have not installed
anything on any server; I built and tested the app and this package, and checked DNS from outside.

This file holds no passwords or keys, only where they are. Keep it that way.

## 1. What it is
- **Claude Agent Runner**: AI coding agents that build software projects for Berk, his father and his friends, by chat
  in the browser and on schedules. Two agents: **Claude** (Anthropic API, Berk's key, billed per use) and **Kimi Code
  CLI** (Berk's Kimi subscription).
- **The web version**: everybody opens one address and signs in with **one shared password**. Everybody sees and works
  on the same projects.
- **Code**: https://github.com/berkkarabacak/berkcode (public, branch `main`). The same code is Berk's Windows app;
  the web version is that app in *server mode* (`RUNNER_SERVER=1`), packaged as one Docker container.

## 2. Where it goes
- **The new server, `2.28.215.62`.** Berk is moving his sites there now. **Not** the old server `2.28.215.22`: nothing
  of this app runs there, and nothing should.
- **Address: `https://agents.berkkarabacak.com`.**
- **DNS** is at Namecheap (Berk's login). It needs one A record: host `agents`, value `2.28.215.62`.
  - **On 2026-11-24 that record did not exist yet.** Berk adds it.
  - While the move runs, `berkkarabacak.com` itself answers with either IP depending on the resolver. That does not
    matter for this subdomain, which has its own record.
- **Certificate**: Let's Encrypt through certbot (webroot `/var/www/certbot`), like the other sites.
- **Access**: your usual root access to the new server. Nothing here needs another login.

## 3. What runs where

| Part | Where |
|---|---|
| App | Docker container `agent-runner` (image `claude-agent-runner:latest`), restart policy `unless-stopped`, published only on `127.0.0.1:4280`. Health check: `curl -s http://127.0.0.1:4280/api/ping` |
| Code checkout | `/opt/agent-runner`, a git clone of the repository. The image is built from it with `deploy/run.sh`. |
| Data | `/var/lib/agent-runner` (owner uid 10001, mode 700). `app/`: the database `app.db` (projects, chats, memory, settings, the Claude key), its daily copies in `app/db-backups/`, restore points, logs. `projects/`: the folders the agents work in. `home/`: the agents' home (Kimi's login and sessions). |
| Limits | 1 CPU at low priority, 1.5 GB of memory without swap, 512 processes, no capabilities, unprivileged user. The container cannot see the host's files or the services the host only offers on `127.0.0.1`. On a big server raise them with `CPUS=` and `MEMORY=` (section 5, step 4). |
| nginx | `/etc/nginx/sites-available/agents.berkkarabacak.com`, linked in `sites-enabled`. Its content is in section 9. |
| Certificate | `/etc/letsencrypt/live/agents.berkkarabacak.com/` |
| Logs | `docker logs agent-runner` (rotated, 3 × 10 MB) |

## 4. Rules (binding)
- **Only add.**
  - Do not stop, change or remove other sites, services or their nginx files, above all while the move to this
    server is running. Agree the timing with whoever moves the other sites.
  - Run `nginx -t` before every `systemctl reload nginx`. Never restart nginx for this app.
- **Secrets.** Never print, paste or commit:
  - the sign-in password, `/var/lib/agent-runner/app/initial-password.txt`;
  - the Claude API key (in the app's database);
  - Kimi's login, in `/var/lib/agent-runner/home/`.

  Do not enter the Claude key or log in to Kimi yourself: Berk does that (section 6).
- **Load.**
  - Start the first build while the server is quiet: it uses up to 2 CPUs for a few minutes.
  - Keep the container's limits.
- **Back up first.** Before changing any existing file: `cp file file.bak-$(date +%F)`, and write down the undo command.
- **Ask Berk** whenever something here does not match the server.

## 5. First deployment (as root on 2.28.215.62)
1. **Right server, DNS in place.**
   - `hostname -I` lists `2.28.215.62`, or `curl -s https://ifconfig.me` prints it.
   - `dig +short agents.berkkarabacak.com @1.1.1.1` prints `2.28.215.62`. If it does not, stop: Berk adds the record
     (section 2). Then wait until it resolves.
2. **What must be there.** Install only what is missing:
   - **Docker:** `docker run --rm hello-world` works. If Docker is missing: `apt-get install -y docker.io`. If it is
     installed but fails, the server may be a Proxmox container without "nesting": stop and tell Berk.
   - **Tools:** `nginx -v`, `certbot --version`, `git --version` and `curl --version` all answer. For any that is
     missing: `apt-get install -y nginx certbot git curl`.
   - **Webroot:** `install -d /var/www/certbot`
   - **Firewall:** ports 80 and 443 are open (`ufw status`, if ufw is active).
   - **Port:** 4280 is free on 127.0.0.1 (`ss -ltn | grep ':4280 '` prints nothing).
   - **Room:** `df -h /` shows at least 5 GB free, and `free -m` at least 2 GB available.
3. **Code:** `git clone https://github.com/berkkarabacak/berkcode.git /opt/agent-runner`. If it is already there:
   `git -C /opt/agent-runner pull`.
4. **Build and start:** `/opt/agent-runner/deploy/run.sh`
   - It builds the image, creates `/var/lib/agent-runner`, starts the container with its limits and waits for the app.
   - It ends with `OK: {"app":"claude-agent-runner",...}` and says where the password file is.
   - On a server with spare capacity: `CPUS=2 MEMORY=3g /opt/agent-runner/deploy/run.sh`.

   Then check:
   - `docker ps --filter name=agent-runner` shows `(healthy)` after about 40 seconds;
   - `docker logs --tail 20 agent-runner` ends with `Claude Agent Runner ... is running at http://127.0.0.1:4280`;
   - `docker stats --no-stream agent-runner` shows the memory limit (`1.5GiB`). If Docker warned that limits are not
     supported, stop and tell Berk.
5. **nginx, step 1** (only what certbot needs):
   - Write the first file from section 9 to `/etc/nginx/sites-available/agents.berkkarabacak.com`.
   - Link it: `ln -s /etc/nginx/sites-available/agents.berkkarabacak.com /etc/nginx/sites-enabled/`
   - Reload: `nginx -t && systemctl reload nginx`
6. **Certificate:**
   - Run `certbot certonly --webroot -w /var/www/certbot -d agents.berkkarabacak.com --deploy-hook 'systemctl reload nginx'`.
   - If certbot asks for an e-mail address because it is new on this server, ask Berk which one.
   - Check that renewals are scheduled: `systemctl list-timers | grep certbot`.
7. **nginx, step 2:**
   - Replace the file with the second one from section 9. If the other sites include common TLS settings, use the
     same lines.
   - Reload: `nginx -t && systemctl reload nginx`
8. **Test from outside.** On the server itself, add `--resolve agents.berkkarabacak.com:443:127.0.0.1`:
   - `curl -sI https://agents.berkkarabacak.com/` gives `302` with `location: /login`;
   - `curl -s https://agents.berkkarabacak.com/login | grep -c 'Enter the password you were given'` prints `1`;
   - `curl -s -o /dev/null -w '%{http_code}\n' https://agents.berkkarabacak.com/api/projects` prints `401`;
   - `curl -s -o /dev/null -w '%{http_code}\n' -X POST https://agents.berkkarabacak.com/mcp/x` prints `404`;
   - `curl -sI http://agents.berkkarabacak.com/` gives `301` to `https://`.

   **All checks at once:** `/opt/agent-runner/deploy/smoke-test.sh`
   - It also signs in and out once, reading the password file without printing it. Run it as root on the server, or
     from anywhere with `BASE=https://agents.berkkarabacak.com /opt/agent-runner/deploy/smoke-test.sh`.
   - It ends with `All checks passed.`
   - GitHub runs the same checks on every change: the "CI" workflow builds this container with `deploy/run.sh`.

## 6. Handing over to Berk
- **Password.**
  - The app made it at its first start: three words and a number, in `/var/lib/agent-runner/app/initial-password.txt`.
  - Tell Berk where it is. He reads it himself.
  - He can change it in the app (Settings → Sign-in password); the file is deleted then.
- **Claude:** Berk signs in and enters his Claude API key under Settings → Claude API key → Test key.
- **Kimi:**
  - Run `docker exec -it agent-runner kimi login`. It prints a web address and a code. If your shell has no terminal,
    leave out `-it`.
  - Give both to Berk. He confirms the code with his Kimi account (his phone is fine), and the command then ends by
    itself.
  - Then, in the app: Settings → Kimi Code CLI → Check again.
- **Sharing:** Berk then gives his father and friends the address and the password.

## 7. How a change reaches users
**By hand. Nothing deploys by itself.** Berk's changes land on `main` on GitHub. Release one when Berk asks:

```
cd /opt/agent-runner && git pull && deploy/run.sh
```

- **What it does:** it builds the new version, stops the old container gracefully and starts the new one. Active
  agent runs are stopped and recorded, waiting chat messages are kept, and the data stays.
- **When:** if you can, release while no agent is working (`docker logs --tail 20 agent-runner`).
- **Undo:**
  - Find the commit to go back to: `git -C /opt/agent-runner log --oneline -5`.
  - Go back: `git -C /opt/agent-runner checkout <commit> && /opt/agent-runner/deploy/run.sh`.
  - Back to the newest: `git -C /opt/agent-runner checkout main && git -C /opt/agent-runner pull && /opt/agent-runner/deploy/run.sh`.
  - Newer versions only add database tables and columns, so going back is safe.

## 8. Everyday commands

| What | Command |
|---|---|
| State and limits | `docker ps --filter name=agent-runner` and `docker stats --no-stream agent-runner` |
| Logs | `docker logs --tail 100 agent-runner` |
| Restart | `docker restart agent-runner` (or Settings → Restart app in the app) |
| New random password, signs everybody out | `docker exec agent-runner node src/cli.js new-password`. It is saved in the same file, never printed. |
| Choose a password, signs everybody out | `docker exec -it agent-runner node src/cli.js set-password` |
| Kimi logged out | `docker exec -it agent-runner kimi login` (then as in section 6) |
| Stop / start | `docker stop agent-runner` / `docker start agent-runner` |
| Remove completely | `docker rm -f agent-runner`; remove the nginx site and reload; `certbot delete --cert-name agents.berkkarabacak.com`; delete `/var/lib/agent-runner` (all projects and their history: ask Berk first) |

- **Backups:**
  - Include `/var/lib/agent-runner` in the server's backups.
  - For a consistent database copy while the app runs, take the newest file in `app/db-backups/` (one a day, the last
    7 are kept), or stop the container first.
- **Troubleshooting:**
  - **nginx answers 502:** the container is down. Check `docker ps -a` and `docker logs --tail 50 agent-runner`,
    then `docker start agent-runner`.
  - **Pages don't update live while an agent works:** the nginx site needs `proxy_buffering off` (section 9).
  - **"Too many wrong passwords":** it passes after 15 minutes. A container restart clears it at once.
  - **Kimi runs fail with "not logged in":** log Kimi in again (section 6).
  - **A run fails with "API key was rejected" or a billing problem:** Berk's Anthropic account (section 10).

## 9. nginx files

**Step 1**, only for getting the certificate:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name agents.berkkarabacak.com;

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 404;
    }
}
```

**Step 2**, the final file:

```nginx
# agents.berkkarabacak.com -> Claude Agent Runner (container "agent-runner" on 127.0.0.1:4280)
server {
    listen 80;
    listen [::]:80;
    server_name agents.berkkarabacak.com;

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name agents.berkkarabacak.com;

    ssl_certificate /etc/letsencrypt/live/agents.berkkarabacak.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/agents.berkkarabacak.com/privkey.pem;

    client_max_body_size 10m;
    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header Referrer-Policy "same-origin" always;

    # The agents' memory addresses only answer inside the container: never pass them on.
    location /mcp/ {
        return 404;
    }

    location / {
        proxy_pass http://127.0.0.1:4280;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header Connection "";
        # Live updates (Server-Sent Events): pass every update on at once and keep the connection open.
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
    }
}
```

## 10. What is not on the server or in this file
- **Berk's own logins:** Namecheap (DNS), the Anthropic account (the Claude key, spending limits) and the Kimi account.
  I don't have them.
- **The app's secrets** (the sign-in password, the Claude key, Kimi's login) live only in `/var/lib/agent-runner`.
  Section 4 applies to all of them.

## 11. When you are done, report to Berk
1. `https://agents.berkkarabacak.com` shows the sign-in page from outside, and `/api/projects` answers `401`.
2. The container is healthy and its limits apply (`docker stats --no-stream agent-runner`).
3. The certificate is valid and renews by itself.
4. Where the password file is (not what is in it), and the two steps left for him: the Claude key in Settings, and
   the Kimi login code.
5. The release command from section 7.
