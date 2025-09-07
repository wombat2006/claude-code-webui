# CLAUDE.md

Minimal guidance for **Claude Code** (claude.ai/code) and similar tools in this repo. Keep this file ≈2 KB; details live in `/docs`.

## Principles

* **Wall–Bounce**: always use at least two LLM passes (propose → critique → revise).
* **/tmp is volatile**: fast scratch only; never store secrets or persistent data.
* **Security first**: validate inputs, sandbox commands, least privilege, small diffs with tests.
* **Clear ops**: log actions; prefer actionable errors.

## Project

Web terminal UI wrapping the Claude Code CLI. React client ↔ Node/Express (TS) server via WebSocket; REST over HTTPS.

## Quick start

```bash
npm install
cd server && npm install && npm run build
cd ../client && npm install
npm run dev          # runs client+server
# or:
cd server && npm run dev
cd client && npm start
```

## Env

Create `server/.env` from `.env.example`:

* `JWT_SECRET`
* `CLAUDE_CODE_PATH`
* `SSL_CERT_PATH`, `SSL_KEY_PATH`
* `SESSION_TIMEOUT`
* `ALLOWED_IPS`
* `MAX_SESSIONS`

## Security (high level)

* Enforce HTTPS (TLS 1.2+); HSTS in prod.
* JWT with short TTL; check on WS upgrade too.
* Rate‑limit `/auth/*` and WS upgrades.
* Strict input validation; strip unsupported control sequences.
* Sandbox subprocess; avoid root; restrict PATH/env.
* Audit log auth/session/command metadata (no secrets).
* Use port **443** behind nginx in prod.

## WebSocket (terminal I/O)

Message shapes:

* `input { data }`
* `resize { cols, rows }`
* `output { data }`
* `status { state, reason? }`

One socket ↔ one CLI process; tear down on disconnect; client auto‑reconnect with backoff.

## Deployment

* **Docker Compose**: nginx TLS termination; health checks; named volumes.
* **Manual**: nginx in front; log rotation & monitoring.

## Further docs

See `/docs`:

* `SECURITY.md` – hardening checklist
* `TROUBLESHOOTING.md` – common fixes
* `ARCHITECTURE.md` – layout & data flow
* `WS_PROTOCOL.md` – full message schema
* `DEPLOYMENT.md` – nginx/compose examples
* `OBSERVABILITY.md` – logs/metrics/tracing

