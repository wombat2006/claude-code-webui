# Troubleshooting Guide

Target stack (compose): `claude-webui-server` (Node:3001, **exposed to the compose network only**) ↔ `claude-webui-client` (React:3000, network only) ↔ **`nginx` (host ports 80/443)**. External access goes through **nginx**.

---

## 0) Service & Port Map

| Component | Container port | Host port | How to reach it from host                                                          |
| --------- | -------------: | --------: | ---------------------------------------------------------------------------------- |
| nginx     |       80 / 443 |  80 / 443 | [http://localhost](http://localhost) , [https://localhost](https://localhost)      |
| server    | 3001 (exposed) |         – | `curl http://claude-webui-server:3001/health` (from **inside** containers/network) |
| client    | 3000 (exposed) |         – | `curl http://claude-webui-client:3000/` (from **inside** containers/network)       |

> `expose` ≠ `ports`: server/client are **not** directly reachable from the host. Don’t expect `localhost:3000/3001` to work.

---

## 1) Fast Diagnostic Path (Dev & Prod)

1. **Check compose status & logs**

```bash
docker-compose ps
docker-compose logs -f --tail=200 nginx claude-webui-server claude-webui-client
```

2. **Health via nginx (from host)**

```bash
curl -vk https://localhost/health   # use -k for self-signed certs
```

3. **nginx → server upstream (from inside nginx)**

```bash
docker-compose exec nginx sh -c 'wget -qO- http://claude-webui-server:3001/health || exit 1'
```

4. **nginx → client upstream (from inside nginx)**

```bash
docker-compose exec nginx sh -c 'wget -qO- http://claude-webui-client:3000/ | head -n 5'
```

---

## 2) Common HTTP/HTTPS Failures

### `502/504` (Bad Gateway / Timeout)

* **Causes**: wrong `proxy_pass`, upstream not running, container name mismatch, network issues.
* **Check**:

  * `docker-compose exec nginx grep -n "proxy_pass" /etc/nginx/nginx.conf`
  * `docker-compose ps` to ensure server/client are up
  * Upstream reachability (see §1-3/§1-4)
* **Fix**: point to `http://claude-webui-server:3001;` and `http://claude-webui-client:3000;`. Then:

```bash
docker-compose exec nginx nginx -t && docker-compose exec nginx nginx -s reload
```

### `404` on the frontend

* **Proxy setup**: ensure `location / { proxy_pass http://claude-webui-client:3000; }` (if proxying the dev server inside compose).
* **Static setup**: if nginx serves the built app, make sure the client image builds `npm run build` and nginx `root` points to the static dir. SPA may need `try_files`.

### `ERR_SSL_PROTOCOL_ERROR` / certificate errors

* Cert/key exist under `./nginx/ssl` and are mounted read-only?
* Inspect cert: `docker-compose exec nginx openssl x509 -in /etc/nginx/ssl/your.crt -noout -text`
* Logs: `/var/log/nginx/error.log` shows `SSL:` lines.
* Smoke: `curl -vk https://localhost/health`.

---

## 3) WebSocket / Socket.IO

### Browser shows “WebSocket connection failed” / missing 101 upgrade

* Ensure nginx has **upgrade headers**:

```nginx
location /socket.io/ {
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "Upgrade";
  proxy_set_header Host $host;
  proxy_pass http://claude-webui-server:3001;
}
```

* If the site is HTTPS, WS must be **`wss://`**. In the client env: `REACT_APP_WS_URL=wss://localhost:443`.
* Check CORS/origin allowlist on the server.

### Quick WS probe

```bash
# Via nginx (auth may be required). Example with headers:
npx wscat -c wss://localhost/socket.io/?EIO=4 \
  -H "Origin: https://localhost" -H "Authorization: Bearer $JWT"
```

---

## 4) Auth / JWT

* Ensure `JWT_SECRET` is set in `server/.env` and matches any token minting logic.
* **Clock skew** between host and containers will cause `exp/nbf` failures → sync time.
* With Socket.IO, **do not** pass tokens in query strings; use handshake `auth` or headers.

---

## 5) Claude Code CLI / Child Process

### `ENOENT` / CLI not found

* Verify path and executable bit:

```bash
docker-compose exec claude-webui-server sh -lc 'echo $CLAUDE_CODE_PATH; ls -l $CLAUDE_CODE_PATH'
```

### Permissions / working directory

* `CLAUDE_WORKING_DIR=/tmp/claude-sessions` must exist and be writable.
* Ensure host directory for the mount exists: `mkdir -p server/tmp`.

### PTY/terminal glitches (blank, resize broken)

* Confirm the frontend sends `resize { cols, rows }` over WS (DevTools → Network → WS frames).
* Cap server output buffers; avoid flooding with huge frames.

---

## 6) Frontend (React)

* **Env vars are compile-time**: changing `REACT_APP_API_URL=https://localhost:443` or `REACT_APP_WS_URL=wss://localhost:443` requires a rebuild.
* When proxying via nginx to `client:3000`, verify the `proxy_pass` route and CORS.
* In DevTools → Network, inspect `/health`, `/auth/login`, `/socket.io/` requests and statuses.

---

## 7) Logs: Where to Look

```bash
# All services
docker-compose logs -f --tail=200 nginx claude-webui-server claude-webui-client

# nginx only
docker-compose exec nginx tail -n 200 -f /var/log/nginx/error.log

# server only (container stdout or /app/logs)
docker-compose logs -f claude-webui-server
```

> Server app logs are mounted at `./server/logs:/app/logs`. If nothing is written, create the host dir and check permissions.

---

## 8) Rate Limiting / 429

* With `RATE_LIMIT_WINDOW_MS=900000` (15 min) and `RATE_LIMIT_MAX_REQUESTS=100`, repeated retries will trigger 429.
* Check logs for “rate limit” and adjust as needed.

---

## 9) Symptom → Fix Cheatsheet

* **`401 Unauthorized`** → expired/invalid JWT or time skew; re-login and sync clocks.
* **`403 Forbidden`** → IP/CORS/authorization rule; check nginx and app controls.
* **`404 Not Found`** → nginx routing or SPA fallback; verify `try_files`/`proxy_pass`.
* **`502 Bad Gateway`** → upstream down/wrong name/network; see §2.
* **`WebSocket failed`** → missing Upgrade headers / `ws://` on HTTPS / CORS; see §3.
* **`EADDRINUSE`** → port already used by another process; ensure no conflicting services.

---

## 10) Reference Smoke Tests

```bash
# From host (through nginx)
echo '--- nginx via TLS'; curl -vk https://localhost/health

# From nginx container to server upstream
docker-compose exec nginx sh -c 'wget -qO- http://claude-webui-server:3001/health && echo OK'

# Login (call server from inside the network)
docker-compose exec nginx sh -c \
  "wget -qO- --method=POST --header='Content-Type: application/json' \
  --body-data='{"username":"demo","password":"demo123"}' \
  http://claude-webui-server:3001/auth/login | head -c 200"
```

---

## 11) Minimal Repro When Stuck

1. `docker-compose down -v` (**`-v` deletes volumes; skip if you need data**)
2. `docker system prune -f` (**caution**)
3. `docker-compose build --no-cache && docker-compose up -d`
4. Follow §1 checks in order (nginx → server/client)
5. Collect timestamped logs (nginx/server/client) and exact steps to reproduce

