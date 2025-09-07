# Security Guidelines

> Compact, actionable hardening guidance for this repo's stack (nginx → Node/Express/Socket.IO → Claude Code CLI). See also: `DEPLOYMENT.md`, `OBSERVABILITY.md`.

---

## 1) TLS / Certificate Management

**Do not store certs under `/root`.** Use system paths and least‑privilege.

**Locations**

* Certs: `/etc/ssl/certs/`
* Private keys: `/etc/ssl/private/`

**Ownership & Permissions**

```bash
# Create/read group for services that need key access
sudo groupadd -f ssl-cert
sudo usermod -aG ssl-cert www-data

# Place files and set ownership
sudo chown root:ssl-cert /etc/ssl/private/site.key
sudo chown root:root     /etc/ssl/certs/site.crt

# Permissions: key readable by group, cert world‑readable
sudo chmod 640 /etc/ssl/private/site.key
sudo chmod 644 /etc/ssl/certs/site.crt
```

> Use `640` (not `600`) on the key **only if** nginx runs as `www-data` in the `ssl-cert` group. Otherwise use `600` and keep access root‑only.

**nginx TLS (snippet)**

```nginx
ssl_protocols TLSv1.2 TLSv1.3;
ssl_ciphers 'HIGH:!aNULL:!MD5';
ssl_prefer_server_ciphers on;
ssl_session_timeout 1d;
ssl_session_cache shared:SSL:10m;
ssl_stapling on; ssl_stapling_verify on;
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
```

**Port policy**

* Dev: Node on `:3001` (HTTP OK)
* Prod: nginx on `:443` → reverse proxy to Node on `:3001`
* Terminate TLS at nginx; do **not** load certs in Node

---

## 2) Process & OS Hardening

**User/privileges**

* Run **nginx** as `www-data` (or distro default) with `ssl-cert` group.
* Run **Node** as a non‑root user. Never bind privileged ports from Node.

**Systemd example (Node)**

```ini
[Service]
User=app
Group=app
Environment=NODE_ENV=production
WorkingDirectory=/srv/app/server
ExecStart=/usr/bin/node dist/index.js
Restart=always
# Limits
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
MemoryMax=512M
LimitNOFILE=65536
```

**Resource controls**

* Configure ulimits and container `mem/cpu` limits.
* Use health checks and restarts (systemd or Docker) for resilience.

---

## 3) Secrets & Config

* Never commit `.env` files. Use a secret manager (e.g., AWS Secrets Manager) or environment injection in CI/CD.
* Rotate `JWT_SECRET`; keep TTL short (e.g., 15–60 min).
* Scope credentials minimally (DB, object storage, third‑party APIs).

---

## 4) Network & Edge

* Restrict inbound to `443`/`80` (80 → 443 redirect). Block direct access to Node if possible (listen on localhost or private network).
* Set **CORS** allowlist to known origins only; disallow `*` in production.
* Consider IP allowlist for admin endpoints and WS upgrade path.

---

## 5) Application Security

**Authentication/Authorization**

* Verify JWT on **REST and WebSocket upgrade**. Reject expired/invalid tokens.
* Pass tokens via Socket.IO `auth` (handshake), not query strings.

**Input validation**

* Enforce command **allowlist** for CLI execution.
* Sanitize args; block shell metacharacters and control sequences.
* Protect against path traversal; resolve & check inside allowed roots.
* Apply length limits; validate JSON schema for API payloads.

**Rate limiting & Abuse control**

* Apply per‑IP and per‑user rate limits to `/auth/*` and WS upgrades.
* Add WS message throughput caps (bytes/sec, msgs/sec) and output backpressure.

**Command execution sandbox**

* Spawn child processes with a restricted env/`PATH` and working dir.
* Drop privileges in containers; avoid `root` in images and at runtime.
* Deny access to `/etc`, `/root`, `/proc` (read), `/var/lib` etc. Mount RO where possible.

**Security headers (via nginx)**

```nginx
add_header X-Content-Type-Options nosniff;
add_header X-Frame-Options DENY;
add_header X-XSS-Protection "1; mode=block";
# If using cookies:
add_header Referrer-Policy no-referrer-when-downgrade;
```

> If you serve the client from nginx, also configure a CSP in `server` blocks or static location.

---

## 6) Logging & Observability

* JSON logs: timestamp, level, requestId, userId, sessionId, remoteIP.
* **Redact** secrets and home directory paths.
* Metrics: active sessions, command latency, WS reconnects, auth failures.
* Ship logs to centralized storage; set retention and alerting on anomalies.

---

## 7) Dependency & Supply Chain

* Pin versions; use lockfiles. Enable Dependabot/Renovate.
* Run `npm audit` in CI; block critical vulns.
* Verify CLI binary integrity (checksum/signature) for Claude Code.

---

## 8) Backup & Recovery

* No sensitive material in `/tmp`—it is volatile by design.
* Back up TLS assets, configuration, and audit logs securely (encrypted at rest, restricted access).
* Document restore steps and test them.

---

## 9) Verification Checklist (pre‑prod)

* [ ] TLS terminates at nginx; strong ciphers; HSTS enabled
* [ ] Node runs as non‑root; direct port blocked; health checks pass
* [ ] JWT TTL short; rotation policy documented
* [ ] CORS allowlist correct; WS upgrade validates JWT & origin
* [ ] Command allowlist enforced; sandbox paths locked down
* [ ] Rate limits configured (REST & WS)
* [ ] Logs redact secrets; metrics/alerts wired
* [ ] Dependencies scanned; critical vulns resolved
* [ ] Backups exist and restore was tested

