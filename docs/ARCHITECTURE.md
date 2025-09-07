# ARCHITECTURE.md — Claude Code WebUI

This document describes the system design for the Claude Code WebUI stack: a secure web terminal wrapper around the Claude Code CLI. It covers components, runtime flows, message contracts, deployment topology, and operational concerns.

---

## 1) System Overview

**Goal:** Provide a browser‑accessible terminal that executes commands via the Claude Code CLI with strong security controls (TLS, auth, sandboxing) and real‑time I/O over WebSockets.

**Stack (Docker Compose):**

* **nginx** — TLS termination, reverse proxy, optional static asset serving. Host ports **80/443**.
* **claude-webui-client** — React app (xterm.js + Socket.IO client). Listens on **:3000** (compose network only).
* **claude-webui-server** — Node/Express (TypeScript) + Socket.IO. Listens on **:3001** (compose network only). Spawns and mediates a Claude Code CLI subprocess per session.

```
Browser (HTTPS) ──▶ nginx (443) ──proxy──▶ server:3001 (REST/WS)
                         │
                         └─(optional) proxy/serve──▶ client:3000 or static bundle

server:3001 ──spawn/pty──▶ Claude Code CLI (child process) ──stdio⇄WS frames
```

---

## 2) Component Responsibilities

### 2.1 nginx (edge)

* Terminates TLS (TLS1.2+), enforces HSTS, sets security headers.
* Proxies `/auth/*`, `/health`, `/socket.io/*` to `server:3001`.
* Optionally proxies `/` to `client:3000` **or** serves built client assets directly.

### 2.2 server (API + WS)

* **Auth:** Issues and verifies JWTs for REST and WS upgrade. **Secrets (JWT secret, and—if implemented—credential hashes) are sourced from AWS Secrets Manager**; local `.env` is used only for dev.
* **Terminal:** For each authenticated WS, spawns a **single** CLI subprocess with a PTY; routes `input`/`output`/`resize` frames; cleans up on disconnect.
* **Security:** Command allowlist/validation, rate limiting, audit logging, resource caps, graceful teardown.
* **Observability:** Structured JSON logs, request/session correlation, `/metrics` endpoint for Prometheus.

### 2.3 client (React)

* **UI:** Login, terminal (xterm.js), session status, error toasts.
* **WS Client:** Socket.IO with auth on handshake; auto‑reconnect with backoff; resize propagation.
* **Config:** `REACT_APP_API_URL`, `REACT_APP_WS_URL` (prefer relative paths when fronted by nginx).

---

## 3) Runtime Flows

### 3.1 Authentication (REST)

```
[Browser] POST /auth/login (username,password)
  └──▶ [nginx] ─proxy─▶ [server] validate creds → issue JWT {sub, iat, exp, jti, role?}
       ◀────────────── 200 { token }
```

**Notes:**

* JWT **must** be presented on subsequent REST and WS upgrade (Socket.IO handshake) requests.
* Short TTL (e.g., 15–60 min) and key rotation via **AWS Secrets Manager** (planned; see §5) are recommended.

### 3.2 WebSocket Upgrade (Socket.IO)

```
[Browser] GET /socket.io/* (Upgrade)
  └──▶ [nginx] set Upgrade/Connection headers → proxy to [server]
       [server] verify JWT + origin → accept 101
```

### 3.3 Terminal I/O Lifecycle

```
WS 'input' { data } ─────▶ CLI stdin
CLI stdout/stderr ───────▶ WS 'output' { data }
WS 'resize' { cols,rows } ▶ PTY resize
Disconnect/error ─────────▶ terminate child; cleanup session; audit
```

**Message contracts (suggested):**

* `input`: `{ data: string }`
* `output`: `{ data: string }`
* `resize`: `{ cols: number, rows: number }`
* `status`: `{ state: 'opened' | 'closed' | 'error', reason?: string }`

---

## 4) Deployment Topology (Compose)

**Services & network**

* `nginx` publishes **80/443** on host.
* `claude-webui-server` exposes **3001** to the compose network (not to host).
* `claude-webui-client` exposes **3000** to the compose network (not to host).

**Volumes**

* Server logs: `./server/logs:/app/logs` (adjustable).
* Session dir: maps to `CLAUDE_WORKING_DIR`. **Default policy is to use `/tmp/claude-sessions` (ephemeral)**.

**Health checks**

* nginx: proxies `/health` to server.
* server: serves `/health` (HTTP 200 on healthy).
* client: optional root GET check if proxied.

---

## 5) Configuration & Secrets

### 5.1 Secrets Source of Truth — **AWS Secrets Manager** (planned/in‑flight)

* **Intended usage:**

  * **JWT secret** (required for all envs beyond local dev).
  * *(Optional, if implemented)* credential hashes or external IdP config.
* **Access pattern:** server fetches secrets on startup using the AWS SDK; credentials provided via IAM role (preferred) or env vars.
* **Fallback for local dev:** `.env` file (never committed with real secrets).

### 5.2 Environment variables (server)

* `PORT=3001`, `NODE_ENV=production`
* `JWT_SECRET` *(overridden by Secrets Manager in staging/prod)*
* `SESSION_TIMEOUT` *(minutes)*, `MAX_SESSIONS`
* `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX_REQUESTS`
* `CLAUDE_CODE_PATH` *(absolute path to CLI binary)*
* `CLAUDE_WORKING_DIR` *(**default `/tmp/claude-sessions`**; see §6)*
* `LOG_LEVEL`

### 5.3 Environment variables (client)

* `REACT_APP_API_URL` (e.g., `https://localhost` or `/`)
* `REACT_APP_WS_URL` (e.g., `wss://localhost` or derived when relative)

---

## 6) Working Directory Policy (Sessions)

* **Default:** `CLAUDE_WORKING_DIR` points to **`/tmp/claude-sessions`**. Treat as **volatile**: files are cleared at container/VM restart.
* **Security:** Do **not** store secrets or long‑lived artifacts under `/tmp`. Use logs volume for audit only (no sensitive payloads).
* **Persistence (optional):** If future requirements demand retention, map a named volume/bind mount and update policy accordingly.

---

## 7) Security Model (summary)

* **Trust zones:** Browser (untrusted) → nginx (edge) → server (app) → CLI (sandboxed child).
* **Transport:** HTTPS only in prod (TLS 1.2+), HSTS enabled.
* **Auth:** JWT verified on REST and WS upgrade; **JWT secret from AWS Secrets Manager** when available.
* **Validation:** Command allowlist; path traversal protection; length caps; control sequence filtering.
* **Execution:** Non‑root containers; child processes with restricted env and working directory under `/tmp/claude-sessions` by default.
* See **`SECURITY.md`** for detailed hardening and header snippets.

---

## 8) Observability & Metrics (Prometheus/Grafana)

**Direction:** Migrate application metrics to **Prometheus + Grafana**. The server exposes **`/metrics`** (Prometheus exposition via `prom-client`). Infra metrics are collected via exporters.

### 8.1 Data Sources

* **App (server)**: Prometheus client in Node.js → `/metrics`.
* **nginx**: `nginx-prometheus-exporter` (or log‑based pipeline).
* **Containers/Host**: **cAdvisor** (container CPU/mem/net/fs) and/or **node\_exporter** (host).

### 8.2 Recommended Metric Families (labels in `{}`)

#### A) Application & Server Load

* `app_active_sessions` **gauge** — current terminal sessions.
* `app_ws_connections` **gauge** — current WS connections `{state="open|closing|closed"}`.
* `app_ws_bytes_in_total` / `app_ws_bytes_out_total` **counter** — WS I/O bytes.
* `app_output_backpressure_drops_total` **counter** — dropped WS frames due to buffering.
* **Node/Process** (from client lib):

  * `process_resident_memory_bytes` **gauge**
  * `process_cpu_user_seconds_total` / `process_cpu_system_seconds_total` **counter**
  * `nodejs_eventloop_lag_seconds` / `nodejs_eventloop_utilization` **gauge**
  * `process_open_fds` **gauge** (if available)

#### B) HTTP & WebSocket Latency

* `http_requests_total{route,method,status}` **counter**
* `http_request_duration_seconds{route,method}` **histogram** (bucketed for p50/p95/p99)
* `app_ws_message_rtt_seconds{channel}` **histogram** — WS message round‑trip (client echo or server timestamping)
* `app_command_latency_seconds{command_group}` **histogram** — terminal command lifecycle (spawn→exit)

#### C) Token Usage & Cost (multi‑LLM)

* `llm_requests_total{provider,model,task_type}` **counter**
* `llm_tokens_total{provider,model,io="prompt|completion"}` **counter**
* `llm_cost_usd_total{provider,model,io}` **counter** — computed via configurable USD per 1k tokens
* (Option) `llm_cost_usd_budget_threshold{env}` **gauge** — injected from config for alerting

> **Implementation note:** maintain a rate table (per provider/model, prompt vs completion). Increment tokens from vendor responses; derive `cost_usd_total` = tokens/1000 × rate.

#### D) Model Health (per LLM)

* `llm_up{provider,model}` **gauge** — 1=healthy/0=down (probe or recent success)
* `llm_latency_seconds{provider,model}` **histogram** — time to first byte / full response
* `llm_errors_total{provider,model,error_type}` **counter** — `timeout|rate_limited|5xx|validation|other`
* `llm_retries_total{provider,model}` **counter**

#### E) Network Usage

* **App‑level**: `app_http_bytes_total{direction}` **counter**, `app_ws_bytes_in_total`, `app_ws_bytes_out_total`, `app_ws_messages_total{type}` **counter**
* **Infra‑level** (via cAdvisor/nginx exporter): container RX/TX bytes, nginx active connections/req rate

#### F) RAG (if used)

* `rag_queries_total{tenant?}` **counter**
* `rag_retrieved_docs_total{k}` **counter** and `rag_retrieved_docs_per_query` **summary**
* `rag_latency_seconds{stage="embed|index|retrieve|rerank"}` **histogram**
* `rag_hits_total` / `rag_queries_total` → Grafana ratio for **hit rate**
* `rag_source_coverage{source}` **gauge** — share of answers per source corpus
* Vector store:

  * `vector_search_latency_seconds{index}` **histogram**
  * `vector_up{index}` **gauge**
  * `vector_qps{index}` **gauge**
* Ingestion/backlog:

  * `rag_ingestion_backlog` **gauge**, `rag_embeddings_queue_depth` **gauge**
  * `rag_chunk_size_bytes` **histogram**

### 8.3 Example Scrape Targets (compose add‑on outline)

* `server:3001/metrics` (app)
* `nginx-exporter:9113/metrics` (nginx)
* `cadvisor:8080/metrics` (containers)
* `node-exporter:9100/metrics` (host)

### 8.4 Alert Ideas (samples)

* **Security/Availability**: sudden rise in `auth_failures_total`, spike in 5xx, `llm_up==0`, WS disconnect surge
* **Performance**: `http_request_duration_seconds:p99 > 1s 5m`, `nodejs_eventloop_lag_seconds > 0.2s`, `app_command_latency_seconds:p95 > SLO`
* **Capacity/Cost**: CPU>85% 5m, RSS>80% limit, `llm_cost_usd_total` daily > budget, token burn rate > baseline

---

## 9) Performance & Limits

* **Session caps:** `MAX_SESSIONS` enforced server‑side.
* **Backpressure:** Cap WS output buffers; throttle server→client emission on large outputs.
* **Resource limits:** optional `NODE_OPTIONS=--max-old-space-size=…`, `ulimits.nofile`, container CPU/mem limits.

---

## 10) Scaling & HA (future‑ready)

* **Horizontal scale (server)** requires a Socket.IO adapter (e.g., Redis) so WS sessions can span replicas.
* **Sticky sessions** at the proxy (or consistent hashing) recommended if not using a shared adapter.
* **Stateless server** aside from PTY; if persistence is introduced, use shared storage or pod affinity.

---

## 11) Directory Layout (reference)

```
repo/
├─ client/
│  └─ src/                   # React app, xterm.js integration, Socket.IO client
├─ server/
│  └─ src/
│     ├─ index.ts            # App bootstrap
│     ├─ controllers/
│     │  └─ authController.ts
│     ├─ middleware/
│     │  ├─ auth.ts          # JWT guard
│     │  └─ security.ts      # headers, rate limits, validation
│     ├─ services/
│     │  ├─ claudeCodeWrapper.ts  # CLI lifecycle, PTY
│     │  └─ socketService.ts      # WS sessions & routing
│     ├─ types/
│     ├─ metrics/            # Prometheus collectors (planned)
│     └─ config/             # env, TLS, logging, secrets provider
├─ nginx/
│  ├─ nginx.conf
│  └─ ssl/
└─ docs/
   ├─ CLAUDE.md
   ├─ SECURITY.md
   ├─ TROUBLESHOOTING.md
   ├─ TESTING_PLAN.md
   └─ COMPREHENSIVE_TEST_PLAN.md
```

---

## 12) Open Questions / Needed Details

To finalize this architecture, please confirm:

1. **Secrets Manager details:** AWS Region, secret names/ARNs (e.g., `claude-webui/jwt`), key structure, and rotation cadence. Confirm whether credential hashes (if any) are also stored there.
2. **Auth user store:** Are users verified against an internal store (demo only) or will an external IdP be integrated later? (Impacts claims like `aud/iss/role`.)
3. **Socket.IO namespace/path:** Strictly `/socket.io/` or custom (e.g., `/terminal`)? Any additional WS events beyond `input/output/resize/status`?
4. **Command allowlist location:** file/env/code and whether it varies by role.
5. **Metrics scrape:** Prometheus scrape config for `server:3001/metrics` and whether an nginx exporter will be added.
6. **Session retention:** Is the default `/tmp` policy sufficient for all environments, or do we need opt‑in persistence for specific cases?
7. **Logging target:** stdout vs files vs centralized (CloudWatch/ELK). Preferred log fields to standardize.

Once confirmed, we will freeze message contracts, headers, and add example Prometheus/Grafana snippets (compose add‑ons and dashboards).

