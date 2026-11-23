# Task for the system manager: put the web version of Claude Agent Runner online

Copy everything below into the system manager's chat.

---

Please deploy the web version of **Claude Agent Runner** (Berk's app) on Berk's server, at
**https://agents.berkkarabacak.com**.

- Code: https://github.com/berkkarabacak/berkcode (public). Follow `deploy/README.md` there, step by step; it has a
  check after each step.
- It is one Docker container (`agent-runner`) behind the server's nginx, with HTTPS from certbot like the other sites.
  All its data goes to `/var/lib/agent-runner`. Everybody signs in with one shared password.

**Before you start**: check DNS with `dig +short agents.berkkarabacak.com`. It must print the server's IP address. If it
does not, stop and ask Berk to add an A record `agents` pointing at the server at his domain registrar.

**Rules** (Berk's usual rules for this server apply as well):
- Do not stop, remove or change the other sites or their nginx files. Only add the new site file, and run `nginx -t`
  before every reload.
- Keep the server's load low: start the first build while CI is idle, and keep the container's limits (1 CPU,
  1.5 GB of memory) in place. If Docker cannot apply them, stop and tell Berk.
- Never print, paste or commit secrets: the sign-in password file (`/var/lib/agent-runner/app/initial-password.txt`),
  the Claude API key, Kimi's login. Tell Berk where the password file is; he reads it himself.
- Do not enter the Claude API key or log in to Kimi yourself: Berk enters the key in the app's Settings, and confirms
  the Kimi login code that `docker exec -it agent-runner kimi login` shows.

**When you are done, report to Berk:**
1. The address works from outside: `https://agents.berkkarabacak.com` shows the sign-in page, and `/api/projects`
   answers `401` without signing in.
2. The container is healthy and its limits are applied (`docker stats --no-stream agent-runner`).
3. The certificate is valid and renews automatically.
4. Where the password file is (not its content), and the two steps left for Berk: enter the Claude API key in
   Settings, and confirm the Kimi login.
5. How to update later: `cd /opt/agent-runner && git pull && deploy/run.sh`.
