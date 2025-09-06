# Tokyo VM Deployment Guide

This guide covers deploying and managing remote worker VMs in Tokyo for distributed workload processing.

## Architecture Overview

```
Main Node (54.65.178.168)       Tokyo, Japan (Sub-Worker VMs)
┌─────────────────────┐         ┌─────────────────────┐
│   Main Coordinator  │  HTTPS  │   Sub-Worker VM 1   │
│   Claude Code WebUI │ ◄─────► │   Context7, Cipher  │
│   1.8GB RAM        │         │   4GB+ RAM          │
│   Job Queue Manager │         └─────────────────────┘
│   Load Balancer     │         ┌─────────────────────┐
└─────────────────────┘         │   Sub-Worker VM 2   │
                                │   Build, Test       │
                                │   8GB+ RAM          │
                                └─────────────────────┘
                                ┌─────────────────────┐
                                │   Sub-Worker VM 3   │
                                │   AI, LLM Tasks     │
                                │   16GB+ RAM         │
                                └─────────────────────┘
```

## Tokyo VM Setup

### 1. VM Requirements

**Minimum Specifications per VM:**
- **CPU**: 2+ cores (4+ recommended)
- **RAM**: 4GB minimum (8GB+ for AI workloads) 
- **Disk**: 20GB SSD
- **Network**: High bandwidth, low latency connection
- **OS**: Ubuntu 22.04 LTS or CentOS 8+

### 2. Install Worker Service on Tokyo VMs

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js 18+
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install PM2 for process management
sudo npm install -g pm2

# Create worker user
sudo useradd -m -s /bin/bash claude-worker
sudo usermod -aG sudo claude-worker

# Switch to worker user
sudo su - claude-worker

# Create worker directory
mkdir -p ~/claude-worker
cd ~/claude-worker

# Clone or copy worker application
# (Worker application should be deployed separately)
```

### 3. Configure Worker Service

Create `/home/claude-worker/claude-worker/.env`:
```bash
# Worker Configuration
WORKER_PORT=3003
WORKER_ID=tokyo-worker-1
WORKER_REGION=tokyo
WORKER_API_KEY=your-secure-api-key-here

# Capabilities
WORKER_CAPABILITIES=context7,cipher,general
WORKER_MAX_CONCURRENT_JOBS=5
WORKER_TIMEOUT=300000

# Memory Configuration  
NODE_MAX_OLD_SPACE_SIZE=2048    # 2GB for worker VMs
NODE_MAX_SEMI_SPACE_SIZE=64
ENABLE_GC_LOGGING=false

# Security
ENABLE_HTTPS=true
SSL_CERT_PATH=/etc/ssl/certs/worker.crt
SSL_KEY_PATH=/etc/ssl/private/worker.key
ALLOWED_COORDINATORS=your-main-vm-ip

# Logging
LOG_LEVEL=info
LOG_FILE=/var/log/claude-worker/worker.log

# System Monitoring
ENABLE_MONITORING=true
VMSTAT_INTERVAL=5
SAR_INTERVAL=30
```

### 4. Start Worker Service

```bash
# Start with PM2
pm2 start ecosystem.config.js
pm2 save
pm2 startup

# Check status
pm2 status
pm2 logs
```

## Main VM Configuration

### 1. Environment Setup

Add to your main VM `.env` file:
```bash
# Load Tokyo configuration
TOKYO_WORKERS=worker1:tokyo-vm1.techsapo.com:3003:context7|cipher:api-key-1,worker2:tokyo-vm2.techsapo.com:3003:build|test:api-key-2

# Security
WORKER_API_KEYS=api-key-1,api-key-2,api-key-3
WORKER_TLS_ENABLED=true

# Performance
TOKYO_WORKER_TIMEOUT=120000
TOKYO_HEALTH_CHECK_INTERVAL=30000
TOKYO_MAX_RETRIES=3
```

### 2. Test Connection

```bash
# Test health endpoint
curl -H "Authorization: Bearer your-api-key" \
  https://tokyo-vm1.techsapo.com:3003/health

# Test worker execution
curl -X POST https://tokyo-vm1.techsapo.com:3003/api/worker/execute \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "jobId": "test-123", 
    "type": "context7",
    "payload": {"operation": "resolve-library", "query": "react"}
  }'
```

## Security Configuration

### 1. API Key Management

Generate secure API keys:
```bash
# Generate random API keys
openssl rand -hex 32  # For each Tokyo worker

# Store securely on main VM
echo "TOKYO_API_KEY_1=generated-key-1" >> .env.tokyo
```

### 2. SSL/TLS Setup

**On Tokyo VMs:**
```bash
# Generate self-signed certificate (or use Let's Encrypt)
sudo openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout /etc/ssl/private/worker.key \
  -out /etc/ssl/certs/worker.crt

# Set proper permissions
sudo chmod 600 /etc/ssl/private/worker.key
sudo chmod 644 /etc/ssl/certs/worker.crt
```

### 3. Firewall Configuration

**Tokyo VMs:**
```bash
# Allow only necessary ports
sudo ufw enable
sudo ufw allow ssh
sudo ufw allow 3003/tcp  # Worker API port
sudo ufw allow from your-main-vm-ip to any port 3003
```

**Main VM:**
```bash
# Allow outbound HTTPS to Tokyo
sudo ufw allow out 443
sudo ufw allow out 3003
```

## Geographic Load Balancing

### 1. Latency-Aware Routing

```javascript
// Automatic routing based on job type and latency
const jobRouting = {
  'context7': 'tokyo-preferred',    // Tokyo workers are optimized for this
  'cipher': 'tokyo-preferred',      // Long-term memory works better with more RAM
  'ai': 'tokyo-only',              // AI workloads need 16GB+ RAM
  'simple-query': 'local-only',    // Keep local for speed
  'cache': 'local-only'            // No need for remote caching
};
```

### 2. Failover Strategy

```javascript
// Automatic failover logic
if (tokyoWorkerLatency > 5000 || tokyoWorkersOffline) {
  routeToLocalWorkers();
} else if (localVMMemoryUsage > 80%) {
  routeToTokyoWorkers();
}
```

## Performance Monitoring

### 1. Tokyo Worker Metrics

Monitor these key metrics for Tokyo workers:
- **Response Time**: Should be < 3s including network latency
- **Success Rate**: Should be > 95%  
- **Memory Usage**: Should be < 80% of available RAM
- **Load Average**: Should be < number of CPU cores
- **Network Latency**: Track round-trip time to Tokyo

### 2. Dashboard Setup

Create monitoring dashboard:
```bash
# Get Tokyo worker stats
curl http://localhost:3001/api/workers/tokyo/stats

# Response:
{
  "totalWorkers": 3,
  "onlineWorkers": 3,
  "avgResponseTime": 1200,
  "capacity": {
    "total": 15,
    "used": 8,
    "utilization": 53.3
  },
  "queue": {
    "pending": 2,
    "active": 8
  }
}
```

### 3. Alerting

Set up alerts for:
- **Worker Offline**: Send notification if Tokyo worker unreachable
- **High Latency**: Alert if response time > 5 seconds
- **Queue Backup**: Alert if job queue > 20 items
- **Memory Pressure**: Alert if Tokyo worker memory > 90%

## Troubleshooting

### Common Issues

**1. Connection Timeout**
```bash
# Check network connectivity
ping tokyo-vm1.techsapo.com
telnet tokyo-vm1.techsapo.com 3003

# Check worker service status
ssh tokyo-vm1.techsapo.com "pm2 status"
```

**2. High Latency**
```bash
# Test network latency
curl -w "@curl-format.txt" https://tokyo-vm1.techsapo.com:3003/health

# Format file (curl-format.txt):
time_namelookup:  %{time_namelookup}\n
time_connect:     %{time_connect}\n
time_appconnect:  %{time_appconnect}\n
time_pretransfer: %{time_pretransfer}\n
time_redirect:    %{time_redirect}\n
time_starttransfer: %{time_starttransfer}\n
time_total:       %{time_total}\n
```

**3. Authentication Failures**
```bash
# Verify API keys match
grep TOKYO_API_KEY .env.tokyo
ssh tokyo-vm1.techsapo.com "grep WORKER_API_KEY .env"
```

**4. Memory Issues on Tokyo Workers**
```bash
# Check memory usage
ssh tokyo-vm1.techsapo.com "free -h"
ssh tokyo-vm1.techsapo.com "ps aux --sort=-%mem | head -10"

# Check worker logs
ssh tokyo-vm1.techsapo.com "tail -f /var/log/claude-worker/worker.log"
```

## Cost Optimization

### 1. Usage-Based Scaling

```javascript
// Scale Tokyo workers based on queue length
if (queueLength > 10) {
  scaleUpTokyoWorkers();
} else if (queueLength < 2 && idleTime > 300000) {
  scaleDownTokyoWorkers();
}
```

### 2. Time-Zone Aware Scheduling

```javascript
// Schedule heavy jobs during Tokyo daytime hours
const tokyoHour = new Date().toLocaleString("en-US", {timeZone: "Asia/Tokyo"});
if (tokyoHour >= 9 && tokyoHour <= 18) {
  preferTokyoWorkers();
} else {
  preferLocalWorkers(); // Reduce Tokyo costs during night
}
```

## Advanced Configuration

### 1. Multi-Region Setup

If you expand beyond Tokyo:
```bash
ASIA_WORKERS=tokyo:tokyo-vm1.techsapo.com:3003,singapore:sg-vm1.example.com:3003
EUROPE_WORKERS=london:london-vm1.example.com:3003
US_WORKERS=oregon:us-vm1.example.com:3003

# Auto-route based on geographic proximity
ENABLE_GEOGRAPHIC_ROUTING=true
```

### 2. Job Persistence

Enable job queue persistence for reliability:
```bash
ENABLE_JOB_PERSISTENCE=true
JOB_QUEUE_BACKUP_FILE=/var/lib/claude-webui/tokyo-jobs.json
BACKUP_INTERVAL=60000  # Backup every minute
```

This setup gives you a robust, secure, and efficient distributed system with your Tokyo VMs handling the heavy workloads while your main VM focuses on coordination!