# Comprehensive Test Plan — Claude Code WebUI

**System under test (SUT):** Docker Compose stack — `nginx` (host ports 80/443) ↔ `claude-webui-client` (React on :3000, *exposed to compose network only*) ↔ `claude-webui-server` (Node/Express/Socket.IO on :3001, *exposed to compose network only*). TLS terminates at **nginx**.

---

## 0) Scope & Priorities

* **P0 (Critical):** Security boundaries, TLS, authentication/JWT, WS upgrade, command sandbox, rate limits.
* **P1 (High):** Core functionality (login → terminal I/O), performance, session limits/timeouts, logging.
* **P2 (Medium):** Resilience (reconnect, restart), UX, edge cases, methodology compliance (Wall–Bounce).

**Out of scope:** Cloud provider specifics beyond nginx/compose; model vendor internals.

---

## 1) Environments & Endpoints

* **Prod‑like (compose)**: Access via `https://localhost` (self‑signed certs accepted with `-k`).
* **Internal upstreams (from containers)**: `http://claude-webui-server:3001/…`, `http://claude-webui-client:3000/…`.
* **Key routes:** `/health`, `/auth/login`, `/socket.io/*` (WS), terminal WS path if distinct.

**Accounts/Test data**

* Demo: `demo/demo123` (do **not** use in production).
* Admin (if present): `admin/admin456`.

---

## 2) P0 — Security Tests

### 2.1 TLS & Headers (nginx)

```bash
# Protocol/cipher survey (host → nginx)
openssl s_client -connect localhost:443 -servername localhost </dev/null 2>/dev/null | openssl x509 -noout -text
nmap --script ssl-enum-ciphers -p 443 localhost
# Force TLS1.3 path
curl -vk --tlsv1.3 https://localhost/health
```

**Accept:** TLS 1.2/1.3 only; strong ciphers; cert/key readable by nginx; `/health` returns 200. HSTS and basic security headers present (see SECURITY.md).

### 2.2 AuthN/Z (JWT)

```bash
# Login (host → nginx)
curl -sk -X POST https://localhost/auth/login \
 -H 'Content-Type: application/json' \
 -d '{"username":"demo","password":"demo123"}' | jq
```

**Accept:** 200 with JWT; invalid creds → 401; expired tokens rejected (simulate by editing `exp`); clock skew produces expected 401.

### 2.3 WS Upgrade & Origin/CORS

* Verify **101** upgrade via browser DevTools and server logs.
* Enforce allowed origins only. **Reject** cross‑origin when not configured.

```bash
# Minimal probe via wscat (sample; adapt to your WS path and auth)
npx wscat -c wss://localhost/socket.io/?EIO=4 \
  -H "Origin: https://localhost" -H "Authorization: Bearer $JWT"
```

### 2.4 Command Sandbox & Input Validation

Craft payloads over WS to ensure allowlist/validation blocks:

* Path traversal: `../../../../etc/passwd`
* Shell metacharacters: `;|&&||$()<>` etc.
* Oversized frames: 10–50 KB repeated.
  **Accept:** Server rejects, logs an audit event, process not compromised.

### 2.5 Rate Limiting / Abuse Controls

* With `RATE_LIMIT_WINDOW_MS=900000` and `RATE_LIMIT_MAX_REQUESTS=100`, hammer `/auth/login` in a loop.
  **Accept:** 429 with retry headers; nginx and server logs show throttling; legit requests recover after window.

---

## 3) P1 — Functional Tests

### 3.1 End‑to‑End User Journey

1. Login → receive JWT. 2) Open WebUI → establish WS. 3) Type `echo hello` → output appears. 4) Resize terminal → server propagates `cols/rows`. 5) Logout → WS closed.
   **Accept:** No console errors; audit log contains user/session/command metadata (without secrets).

### 3.2 Session Limits & Timeout

* Set `MAX_SESSIONS=10`; attempt to open 11th session.
  **Accept:** Graceful refusal (HTTP 429/403 or WS error) and log event.
* Set `SESSION_TIMEOUT` low (e.g., 1–2 min); idle until timeout.
  **Accept:** Token/session invalidated; new auth required.

### 3.3 Logging & Redaction

* Trigger auth, open/close sessions, run benign commands.
  **Accept:** JSON logs include timestamp, level, requestId, userId, sessionId; **no secrets**; paths redacted if needed.

---

## 4) P1 — Performance & Capacity

### 4.1 Baseline Latencies (host → nginx)

```bash
curl -skw '\nconnect:%{time_connect} tls:%{time_appconnect} ttfb:%{time_starttransfer} total:%{time_total}\n' \
  -o /dev/null https://localhost/health
```

**Targets (guideline):** connect≤50ms, TLS≤120ms (self‑signed varies), TTFB≤100ms, total≤200ms locally.

### 4.2 HTTP burst & WS fan‑out

* **HTTP**: `npx autocannon -d 30 -c 50 https://localhost/health` (expect low error rate, stable p95).
* **WS**: small Node script to open N sockets (e.g., N=10–20), send periodic `input`/`resize`.
  **Accept:** Server CPU<80%, memory stable; no WS mass disconnects; p95 WS message RTT <150ms locally.

### 4.3 Resource Guardrails

* Confirm Node stays within memory budget (e.g., `--max-old-space-size=512` if set). No unbounded growth after 10–15 minutes of activity.

---

## 5) P2 — Resilience & Recovery

### 5.1 Network Blips & Reconnect

* Drop network for the client container or kill WS briefly; verify client auto‑reconnect with backoff.
  **Accept:** Session resumes; no orphaned child processes.

### 5.2 Process Restarts

* `docker-compose restart claude-webui-server` while clients connected.
  **Accept:** Clients reconnect; new processes clean; previous PTYs are cleaned up and logged.

### 5.3 Child Process Failures

* Simulate CLI crash/exit.
  **Accept:** Server emits `status: 'error'`; UI displays recoverable error; user can relaunch session.

---

## 6) Methodology Compliance (Wall–Bounce) — Optional

Ensure internal engineering process follows **propose → critique → revise** with at least two LLM passes for risky changes:

* PR template includes Wall–Bounce notes and test evidence.
* Unit tests accompany functional edits.
  **Accept:** Evidence present on PRs in scope; not a runtime SUT feature.

---

## 7) Test Data, Observability & Artifacts

* **Artifacts:** curl/autocannon outputs, WS probe logs, screenshots of DevTools WS frames, server/nginx logs.
* **Dashboards (optional):** session count, WS connects, auth failures, rate‑limited requests, error rates.
* **Retention:** keep raw logs for at least the iteration.

---

## 8) CI Integration (Example)

```yaml
# .github/workflows/tests.yml (illustrative)
name: WebUI Tests
on: [push, pull_request]
jobs:
  compose:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Build & up
        run: |
          docker-compose build
          docker-compose up -d
      - name: Wait for health
        run: |
          for i in {1..20}; do curl -sk https://localhost/health && exit 0 || sleep 3; done; exit 1
      - name: Security smoke
        run: |
          curl -sk --tlsv1.3 https://localhost/health
      - name: Auth smoke
        run: |
          curl -sk -X POST https://localhost/auth/login \
            -H 'Content-Type: application/json' \
            -d '{"username":"demo","password":"demo123"}'
      - name: Teardown
        if: always()
        run: docker-compose down -v
```

---

## 9) Exit / Quality Gates

* **P0:** 100% pass — TLS/headers, auth/JWT, WS upgrade, sandbox, rate limits.
* **P1:** ≥95% pass — core flows, performance targets met; logs structured & redacted.
* **P2:** Key resilience scenarios verified (reconnect, restart, child crash).
* **No critical security findings** outstanding.

---

## 10) Quick Reference — Commands

```bash
# Compose status/logs
docker-compose ps
docker-compose logs -f --tail=200 nginx claude-webui-server claude-webui-client

# Health via nginx (host)
curl -vk https://localhost/health

# Upstream checks from nginx container
docker-compose exec nginx sh -c 'wget -qO- http://claude-webui-server:3001/health || exit 1'
docker-compose exec nginx sh -c 'wget -qO- http://claude-webui-client:3000/ | head -n 5'

# Login (host → nginx)
curl -sk -X POST https://localhost/auth/login -H 'Content-Type: application/json' \
  -d '{"username":"demo","password":"demo123"}'

# WS probe (adjust path/auth)
npx wscat -c wss://localhost/socket.io/?EIO=4 -H 'Origin: https://localhost' -H "Authorization: Bearer $JWT"
```

