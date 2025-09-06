# Distributed Worker Architecture

This document describes the distributed architecture for offloading memory-intensive tasks to separate worker VMs.

## Architecture Overview

```
Main VM (1.8GB RAM)     Worker VMs (4GB+ RAM each)
┌─────────────────┐    ┌─────────────────┐  ┌─────────────────┐
│   Web UI        │    │   Worker Node   │  │   Worker Node   │
│   API Server    │────│   Context7      │  │   Cipher MCP    │
│   Job Queue     │    │   Light Tasks   │  │   Heavy Tasks   │
└─────────────────┘    └─────────────────┘  └─────────────────┘
```

## Components

### 1. Main VM (Coordinator)
- **Role**: Web UI, API endpoints, job distribution
- **Memory**: ~256MB Node.js heap limit
- **Responsibilities**:
  - Handle HTTP requests
  - Distribute jobs to workers
  - Manage worker health checks
  - Cache lightweight results

### 2. Worker VMs
- **Role**: Execute memory-intensive tasks
- **Memory**: 4GB+ recommended
- **Capabilities**:
  - Context7 MCP operations
  - Cipher framework operations
  - Heavy computation tasks
  - LLM context processing

## Configuration

### Environment Variables

Add to main VM `.env`:
```bash
# Worker node configuration
WORKER_NODES=worker1.local:3003:context7|cipher,worker2.local:3003:heavy-compute
# Format: host:port:capability1|capability2,host:port:capabilities

# Memory limits for main VM
NODE_MAX_OLD_SPACE_SIZE=256
NODE_MAX_SEMI_SPACE_SIZE=16
GC_INTERVAL=30
MEMORY_THRESHOLD=80
```

### Worker VM Setup

Each worker VM should run the worker service:

```bash
# Install Node.js and dependencies
sudo apt update && sudo apt install nodejs npm

# Clone worker service
git clone [worker-repo-url]
cd claude-worker

# Install dependencies
npm install

# Set worker configuration
echo "WORKER_PORT=3003" > .env
echo "WORKER_CAPABILITIES=context7,cipher,heavy-compute" >> .env
echo "NODE_MAX_OLD_SPACE_SIZE=2048" >> .env  # 2GB for workers

# Start worker service
npm start
```

## Job Types and Distribution

### Supported Job Types

1. **context7** - Context7 documentation retrieval
2. **cipher** - Cipher framework operations  
3. **heavy-compute** - CPU/memory intensive tasks
4. **general** - Any task (fallback capability)

### Job Flow

1. **Submit Job**: Main VM receives request
2. **Queue Job**: Added to internal job queue
3. **Select Worker**: Find healthy worker with required capability
4. **Execute**: Send job to worker via HTTP POST
5. **Monitor**: Track job progress and health
6. **Return Result**: Send response back to client

### Example Job Submission

```typescript
// In your API endpoint
const jobId = await workerPool.submitJob('context7', {
  action: 'resolve-library',
  query: 'react'
}, 30000); // 30 second timeout

const result = await workerPool.waitForJob(jobId);
```

## Worker Health Monitoring

### Health Check Endpoint
Workers must implement: `GET /health`
```json
{
  "status": "healthy",
  "memory": { "used": "1.2GB", "total": "4GB" },
  "uptime": 3600,
  "capabilities": ["context7", "cipher"]
}
```

### Automatic Recovery
- **Health checks**: Every 30 seconds
- **Failed jobs**: Retry up to 2 times on different workers
- **Dead workers**: Removed from pool automatically
- **Job redistribution**: Failed jobs moved to healthy workers

## Memory Optimization Strategies

### Main VM Optimizations
```bash
# Node.js memory limits
node --max-old-space-size=256 \
     --max-semi-space-size=16 \
     --expose-gc \
     server.js

# Automatic garbage collection
export GC_INTERVAL=30  # Force GC every 30 seconds
export MEMORY_THRESHOLD=80  # Alert at 80% memory usage
```

### Worker VM Optimizations
```bash
# Higher memory limits for workers
node --max-old-space-size=2048 \
     --max-semi-space-size=64 \
     worker.js

# Process isolation
export WORKER_MAX_CONCURRENT_JOBS=3
export WORKER_IDLE_TIMEOUT=300  # Kill idle processes after 5 minutes
```

## API Endpoints

### Worker Pool Management
```bash
# Get worker pool status
GET /api/workers/status

# Add worker node
POST /api/workers/add
{
  "host": "worker3.local",
  "port": 3003,
  "capabilities": ["context7", "cipher"]
}

# Remove worker node
DELETE /api/workers/remove/worker3.local:3003

# Get job statistics
GET /api/workers/jobs/stats
```

### Distributed Context7 Operations
```bash
# These automatically use worker nodes
POST /api/context7/resolve      # Distributed to context7 workers
GET /api/context7/docs/:id      # Distributed to context7 workers
GET /api/context7/search        # Distributed to context7 workers
```

## Deployment Strategies

### 1. Multi-VM Setup
```yaml
# docker-compose.yml for worker nodes
version: '3.8'
services:
  worker:
    build: ./worker
    ports:
      - "3003:3003"
    environment:
      - NODE_MAX_OLD_SPACE_SIZE=2048
      - WORKER_CAPABILITIES=context7,cipher,heavy-compute
    deploy:
      resources:
        limits:
          memory: 4G
        reservations:
          memory: 2G
```

### 2. Kubernetes Deployment
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: claude-worker
spec:
  replicas: 3
  selector:
    matchLabels:
      app: claude-worker
  template:
    metadata:
      labels:
        app: claude-worker
    spec:
      containers:
      - name: worker
        image: claude-worker:latest
        resources:
          requests:
            memory: "2Gi"
          limits:
            memory: "4Gi"
        env:
        - name: NODE_MAX_OLD_SPACE_SIZE
          value: "2048"
```

### 3. Auto-Scaling
Configure workers to auto-scale based on:
- **CPU Usage**: Scale up when CPU > 70%
- **Memory Usage**: Scale up when memory > 80%  
- **Queue Length**: Scale up when jobs queued > 10
- **Response Time**: Scale up when avg response > 5s

## Monitoring and Logging

### Metrics to Track
- **Worker Health**: Response time, memory usage, CPU usage
- **Job Metrics**: Queue length, completion rate, failure rate
- **Network**: Request latency between main VM and workers
- **Resource Usage**: Memory/CPU per worker node

### Logging Strategy
```bash
# Main VM logs
/var/log/claude-webui/coordinator.log  # Job distribution
/var/log/claude-webui/workers.log      # Worker health checks

# Worker VM logs  
/var/log/claude-worker/jobs.log        # Job execution
/var/log/claude-worker/health.log      # Health status
```

### Alerts
- **Worker Down**: Email/Slack notification
- **High Queue Length**: Scale up recommendation
- **Memory Threshold**: Worker memory > 90%
- **Job Failures**: Failure rate > 5%

## Security Considerations

### Network Security
- **VPN/Private Network**: All worker communication via private network
- **TLS Encryption**: HTTPS for all worker communication
- **Authentication**: JWT tokens for worker API access
- **Firewall**: Only allow main VM to access worker ports

### Process Isolation
- **Container Isolation**: Run workers in Docker containers
- **User Permissions**: Workers run as non-root users
- **Resource Limits**: Memory/CPU limits per container
- **Sandboxing**: Restrict file system access

## Troubleshooting

### Common Issues

**Worker not responding**
```bash
# Check worker health
curl http://worker1.local:3003/health

# Check worker logs
tail -f /var/log/claude-worker/jobs.log

# Restart worker service
sudo systemctl restart claude-worker
```

**High memory usage on main VM**
```bash
# Check memory usage
free -h

# Force garbage collection
curl -X POST http://localhost:3001/api/gc

# Check job queue length
curl http://localhost:3001/api/workers/jobs/stats
```

**Jobs failing consistently**
```bash
# Check worker capabilities
curl http://localhost:3001/api/workers/status

# Clear job queue
curl -X DELETE http://localhost:3001/api/workers/jobs/clear

# Restart worker pool
sudo systemctl restart claude-webui
```

This distributed architecture allows the main 1.8GB VM to handle web requests efficiently while offloading memory-intensive Context7 and Cipher operations to dedicated worker VMs with more resources.