# Claude Code WebUI - Production Deployment Guide

## 🚀 Quick Start

### 1. Prerequisites
- Ubuntu/Debian server with 8GB+ RAM
- Domain name pointing to your server
- SSL certificate for your domain

### 2. Automated Setup
```bash
# Clone the repository
git clone https://github.com/your-org/claude-code-webui.git
cd claude-code-webui/server

# Run production setup
./scripts/setup-production.sh
```

### 3. Configuration
Edit production environment file:
```bash
sudo nano /opt/claude-webui/server/.env.production
```

**Critical settings to change:**
- `JWT_SECRET` - Generate a strong random key
- `FRONTEND_URL` - Your domain
- `ALLOWED_ORIGINS` - Your domain(s)
- SSL certificate paths

### 4. SSL Certificate Setup
```bash
# Using Let's Encrypt (recommended)
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d yourdomain.com

# Or place your certificates:
sudo cp your-cert.pem /etc/ssl/certs/techsapo.com.pem
sudo cp your-key.key /etc/ssl/private/techsapo.com.key
```

### 5. Start Services
```bash
sudo systemctl start claude-webui
sudo systemctl start nginx
sudo systemctl status claude-webui
```

## 🏗️ Architecture

```
Internet → Nginx (SSL, Rate Limiting) → Node.js Server → Redis/MCP
```

**Components:**
- **Nginx**: SSL termination, rate limiting, static files
- **Node.js**: API server, WebSocket handling
- **Redis**: Session storage, caching
- **MCP Servers**: Claude Code integration

## 🔒 Security Features

### Network Security
- HTTPS enforced (HSTS)
- Rate limiting per IP
- CORS protection
- Security headers

### Application Security
- JWT authentication
- Input validation
- XSS protection
- CSRF protection

### System Security
- Non-root user execution
- Systemd sandboxing
- Resource limits
- Firewall rules

## 📊 Monitoring

### Health Checks
```bash
# Service status
sudo systemctl status claude-webui

# Application logs
sudo journalctl -u claude-webui -f

# Nginx logs
sudo tail -f /var/log/nginx/claude-webui-access.log

# Health endpoint
curl https://yourdomain.com/health
```

### Metrics Endpoints
- `GET /health` - Basic health check
- `GET /api/server-info` - Server statistics
- `GET /api/session/stats` - Session statistics

## 🐳 Docker Deployment

### Option 1: Docker Compose
```bash
# Copy production environment
cp .env.production .env

# Start services
docker-compose -f docker-compose.production.yml up -d

# Check status
docker-compose -f docker-compose.production.yml ps
```

### Option 2: Manual Docker
```bash
# Build image
docker build -f Dockerfile.production -t claude-webui .

# Run container
docker run -d \
  --name claude-webui \
  --env-file .env.production \
  -p 3001:3001 \
  -v claude-sessions:/var/lib/claude-sessions \
  claude-webui
```

## ⚙️ Configuration Reference

### Environment Variables

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `NODE_ENV` | Environment | `production` | ✅ |
| `PORT` | Server port | `3001` | ✅ |
| `JWT_SECRET` | JWT signing key | - | ✅ |
| `FRONTEND_URL` | Frontend URL | - | ✅ |
| `ALLOWED_ORIGINS` | CORS origins | - | ✅ |
| `MAX_SESSIONS` | Max concurrent sessions | `10` | ❌ |
| `RATE_LIMIT_MAX_REQUESTS` | Rate limit | `50` | ❌ |

### Resource Limits

| Component | Memory | CPU | Storage |
|-----------|--------|-----|---------|
| Node.js | 1GB | 50% | - |
| Redis | 256MB | 25% | 1GB |
| Sessions | - | - | 10GB |
| Logs | - | - | 5GB |

## 🚨 Troubleshooting

### Common Issues

#### Service won't start
```bash
# Check logs
sudo journalctl -u claude-webui -n 50

# Check configuration
sudo -u claude node -c "require('/opt/claude-webui/server/.env.production')"

# Check permissions
sudo ls -la /var/lib/claude-sessions
```

#### Memory issues
```bash
# Check memory usage
free -h
docker stats (if using Docker)

# Adjust limits in systemd
sudo systemctl edit claude-webui
```

#### SSL/Certificate issues
```bash
# Check certificate validity
sudo openssl x509 -in /etc/ssl/certs/techsapo.com.pem -text -noout

# Test nginx configuration
sudo nginx -t

# Reload nginx
sudo systemctl reload nginx
```

#### High CPU usage
```bash
# Check processes
top -p $(pgrep -d',' node)

# Check for memory leaks
curl https://yourdomain.com/api/server-info
```

## 🔄 Updates

### Application Updates
```bash
cd /opt/claude-webui/server
sudo -u claude git pull
sudo -u claude npm ci --production
sudo -u claude npm run build
sudo systemctl restart claude-webui
```

### System Updates
```bash
sudo apt update && sudo apt upgrade
sudo systemctl restart nginx redis-server
```

## 📈 Scaling

### Horizontal Scaling
- Use load balancer (nginx upstream)
- Shared Redis instance
- Session affinity for WebSocket

### Vertical Scaling
- Increase memory limits
- Add CPU cores
- SSD storage for sessions

## 🛡️ Backup

### Data to Backup
- `/var/lib/claude-sessions` - User sessions
- `/opt/claude-webui/server/.env.production` - Configuration
- `/etc/ssl/` - SSL certificates
- Redis data (if using persistence)

### Backup Script
```bash
#!/bin/bash
tar -czf "backup-$(date +%Y%m%d).tar.gz" \
  /var/lib/claude-sessions \
  /opt/claude-webui/server/.env.production \
  /etc/ssl/certs/techsapo.com.pem
```

## 📞 Support

- **Logs**: `/var/log/claude-webui/`
- **Health**: `https://yourdomain.com/health`
- **Metrics**: `https://yourdomain.com/api/server-info`