# Testing Plan — Claude Code WebUI (Docker Compose)

**SUT (System Under Test):** `nginx` (host ports 80/443) ↔ `claude-webui-client` (React on :3000, exposed to compose network only) ↔ `claude-webui-server` (Node/Express/Socket.IO on :3001, exposed to compose network only). TLS terminates at **nginx**.

---

## 0) Assumptions & Test Data

* **Access:** Host reaches only `https://localhost` (self‑signed certs allowed with `-k`).
* **Upstreams (from containers):** `http://claude-webui-server:3001`, `http://claude-webui-client:3000`.
* **Env (server):** `JWT_SECRET`, `SESSION_TIMEOUT`, `MAX_SESSIONS`, `RATE_LIMIT_*`, `CLAUDE_CODE_PATH`, `CLAUDE_WORKING_DIR` are set via compose.
* **Demo Accounts:** `demo/demo123` (and `admin/admin456` if enabled). Do **not** use in production.
* **WS paths:** Socket.IO under `/socket.io/` (adjust if your app differs).

---

## 1) Test Categories & Traceable Cases

### A. User Interface

* **TC-UI-001 — Login UI**
  **Steps:** Open `https://localhost`; verify form renders; submit invalid creds; submit valid creds.
  **Expect:** Invalid → descriptive error; valid → redirected to terminal page; no console errors.
* **TC-UI-002 — Responsiveness & Theme**
  **Steps:** Resize viewport (mobile/tablet/desktop); toggle dark mode if available.
  **Expect:** Layout adapts; terminal remains usable; theme persists if designed to.
* **TC-UI-003 — Query/Input Controls (if present)**
  **Steps:** Type long text (10k chars) in any input; submit; navigate back/forward.
  **Expect:** Length caps enforced with friendly error; no freezes.

### B. Authentication & Session

* **TC-AUTH-001 — Login Success/Failure**
  **Steps:** `curl -sk -X POST https://localhost/auth/login -H 'Content-Type: application/json' -d '{"username":"demo","password":"wrong"}'`; then with valid pass.
  **Expect:** 401 on wrong creds; 200 with JWT on success; token fields sane (iat/exp).
* **TC-AUTH-002 — Expired/Invalid JWT**
  **Steps:** Tamper `exp` to the past; call an authenticated API/WS.
  **Expect:** 401/close with clear error.
* **TC-AUTH-003 — Session Timeout**
  **Pre:** Set `SESSION_TIMEOUT` low (e.g., 2 min).
  **Steps:** Idle until timeout; try action.
  **Expect:** Forced re‑auth; WS closed.
* **TC-AUTH-004 — Max Sessions**
  **Pre:** `MAX_SESSIONS=10`.
  **Steps:** Open 11 parallel sessions.
  **Expect:** Last one refused (HTTP/WS); audit log written.

### C. WebSocket / Terminal I/O

* **TC-WS-001 — Connect & Echo**
  **Steps:** Open UI; run `echo hello`.
  **Expect:** Output appears; latency under \~150 ms locally.
* **TC-WS-002 — Resize**
  **Steps:** Resize terminal columns/rows.
  **Expect:** PTY size changes; wrapped lines reflow.
* **TC-WS-003 — Long Output / Backpressure**
  **Steps:** `yes x | head -n 5000` or large directory listing.
  **Expect:** No freeze; output capped/buffered; UI remains responsive.
* **TC-WS-004 — Disconnect/Reconnect**
  **Steps:** Drop network (disable interface) or `docker-compose restart claude-webui-server`.
  **Expect:** Client auto‑reconnects with backoff; orphaned PTYs cleaned.

### D. Security (Runtime)

* **TC-SEC-001 — TLS & Headers**
  **Steps:** `curl -vk --tlsv1.3 https://localhost/health`; check HSTS, XFO, X‑Content‑Type‑Options in response headers.
  **Expect:** 200; strong TLS; security headers present (per `SECURITY.md`).
* **TC-SEC-002 — Origin/CORS**
  **Steps:** From a different Origin, attempt requests/WS.
  **Expect:** Blocked unless allowlisted.
* **TC-SEC-003 — Rate Limiting**
  **Steps:** Hammer `/auth/login` above `RATE_LIMIT_MAX_REQUESTS` within window.
  **Expect:** 429 with retry headers; recovers after window.
* **TC-SEC-004 — Input Validation / Sandbox**
  **Steps:** Send `../../etc/passwd`, `; cat /etc/passwd`, and oversized WS frames.
  **Expect:** Rejected; audited; no command injection.

### E. Performance & Capacity (Local Targets)

* **TC-PERF-001 — HTTP Latency Baseline**
  **Steps:** `curl -skw '\nconnect:%{time_connect} tls:%{time_appconnect} ttfb:%{time_starttransfer} total:%{time_total}\n' -o /dev/null https://localhost/health`.
  **Expect:** total ≤ \~200 ms locally.
* **TC-PERF-002 — WS Fan‑out**
  **Steps:** Open 10–20 WS connections via a small script; send periodic `input`/`resize`.
  **Expect:** Stable CPU (<80%), no mass disconnects.
* **TC-PERF-003 — Memory Stability**
  **Steps:** 15‑minute active session with continuous output.
  **Expect:** No unbounded heap growth (if set, stays within `NODE_OPTIONS --max-old-space-size`).

### F. Resilience

* **TC-RES-001 — Nginx Reload**
  **Steps:** `docker-compose exec nginx nginx -s reload`.
  **Expect:** No dropped active sessions.
* **TC-RES-002 — Server Restart**
  **Steps:** `docker-compose restart claude-webui-server`.
  **Expect:** Clients reconnect; logs show clean teardown.
* **TC-RES-003 — CLI Crash**
  **Steps:** Simulate child process exit.
  **Expect:** UI shows recoverable error; relaunch works.

### G. Multi‑Model “Wall–Bounce” Workflow (If Implemented)

* **TC-WB-001 — Minimum Two‑Model Pass**
  **Steps:** Trigger propose → critique → revise using 2 different models.
  **Expect:** At least one critique pass; diffs applied; tests generated when changes occur.
* **TC-WB-002 — Bounce Cap**
  **Steps:** Trigger 5 passes on a complex prompt.
  **Expect:** Hard stop at cap; summary produced.
* **TC-WB-003 — Improvement Metric**
  **Steps:** Compare initial vs final answer length/score.
  **Expect:** Improvement ratio ≥ 1.2 (tunable).

### H. Browser Compatibility

* **TC-COMP-001..004 — Latest Chrome/Firefox/Safari/Edge**
  **Steps:** Load UI, login, run commands, resize.
  **Expect:** No functional differences; fonts/clipboard OK.
* **TC-COMP-005..006 — iOS Safari / Android Chrome**
  **Expect:** Responsive layout; terminal input works with soft keyboard.

---

## 2) Execution Phases

* **Phase 1 (1–2d):** A/B/C basic flows + D(TLS/auth).
* **Phase 2 (2–3d):** C backpressure, D abuse, E perf.
* **Phase 3 (2–3d):** F resilience, G wall–bounce (if enabled), H browsers.

---

## 3) Setup & Smoke Commands

```bash
# Bring up stack
docker-compose up -d
# Health via nginx (host)
curl -vk https://localhost/health
# Upstreams from inside nginx
docker-compose exec nginx sh -c 'wget -qO- http://claude-webui-server:3001/health && echo OK'
# Login
curl -sk -X POST https://localhost/auth/login -H 'Content-Type: application/json' \
  -d '{"username":"demo","password":"demo123"}' | jq
```

---

## 4) Exit / Quality Gates

* **P0:** 100% pass (TLS, JWT, WS upgrade, sandbox, rate limits).
* **P1:** ≥95% pass (core flows, perf targets).
* **P2:** Key resilience scenarios verified.
* **No critical security findings** remain.

---

## 5) Result Recording (per case)

* Case ID / Date‑time / Tester / Env
* Steps & Evidence (logs, screenshots, curl output)
* **Result (Pass/Fail)** and defect link
* Notes / Follow‑ups

