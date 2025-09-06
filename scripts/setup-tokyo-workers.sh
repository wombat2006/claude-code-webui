#!/bin/bash

# Tokyo Worker Setup Script
# Run this on each Tokyo VM to configure them for your coordinator at 54.65.178.168

set -e

COORDINATOR_IP="54.65.178.168"
WORKER_PORT="3003"
WORKER_API_KEY="${1:-}"

if [ -z "$WORKER_API_KEY" ]; then
    echo "Usage: $0 <worker-api-key>"
    echo "Example: $0 $(openssl rand -hex 32)"
    exit 1
fi

echo "=== Tokyo Worker Setup for Coordinator $COORDINATOR_IP ==="

# Update system
echo "Updating system packages..."
sudo apt update && sudo apt upgrade -y

# Install Node.js 18
echo "Installing Node.js 18..."
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install required packages
sudo apt-get install -y build-essential python3-pip nginx certbot python3-certbot-nginx

# Install PM2 globally
echo "Installing PM2..."
sudo npm install -g pm2

# Create worker user
echo "Creating claude-worker user..."
sudo useradd -m -s /bin/bash claude-worker || echo "User already exists"
sudo usermod -aG sudo claude-worker

# Create directories
echo "Setting up directories..."
sudo mkdir -p /opt/claude-worker
sudo mkdir -p /var/log/claude-worker
sudo mkdir -p /etc/claude-worker
sudo chown -R claude-worker:claude-worker /opt/claude-worker
sudo chown -R claude-worker:claude-worker /var/log/claude-worker

# Generate SSL certificate
echo "Generating SSL certificate..."
sudo mkdir -p /etc/ssl/claude-worker
sudo openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
    -keyout /etc/ssl/claude-worker/worker.key \
    -out /etc/ssl/claude-worker/worker.crt \
    -subj "/C=JP/ST=Tokyo/L=Tokyo/O=Claude Worker/CN=$(hostname -f)"

sudo chmod 600 /etc/ssl/claude-worker/worker.key
sudo chmod 644 /etc/ssl/claude-worker/worker.crt

# Configure firewall
echo "Configuring firewall..."
sudo ufw --force enable
sudo ufw allow ssh
sudo ufw allow from $COORDINATOR_IP to any port $WORKER_PORT
sudo ufw allow 80/tcp   # For Let's Encrypt
sudo ufw allow 443/tcp  # For HTTPS

# Create worker environment file
echo "Creating worker configuration..."
sudo tee /etc/claude-worker/.env > /dev/null <<EOF
# Worker Configuration
NODE_ENV=production
WORKER_PORT=$WORKER_PORT
WORKER_ID=tokyo-$(hostname)
WORKER_REGION=tokyo
WORKER_API_KEY=$WORKER_API_KEY

# Coordinator Configuration  
COORDINATOR_IP=$COORDINATOR_IP
ALLOWED_COORDINATORS=$COORDINATOR_IP

# Capabilities - Adjust based on VM specs
WORKER_CAPABILITIES=context7,cipher,general,build,test,ai
WORKER_MAX_CONCURRENT_JOBS=5
WORKER_TIMEOUT=300000

# Memory Configuration (adjust based on VM RAM)
NODE_MAX_OLD_SPACE_SIZE=2048
NODE_MAX_SEMI_SPACE_SIZE=64
ENABLE_GC_LOGGING=false

# Security
ENABLE_HTTPS=true
SSL_CERT_PATH=/etc/ssl/claude-worker/worker.crt
SSL_KEY_PATH=/etc/ssl/claude-worker/worker.key

# Logging
LOG_LEVEL=info
LOG_FILE=/var/log/claude-worker/worker.log
LOG_MAX_SIZE=10485760  # 10MB
LOG_MAX_FILES=5

# System Monitoring
ENABLE_MONITORING=true
VMSTAT_INTERVAL=5
SAR_INTERVAL=30
HEALTH_CHECK_INTERVAL=10000

# Performance Tuning
CLUSTER_WORKERS=0  # 0 = auto-detect CPU cores
ENABLE_COMPRESSION=true
REQUEST_TIMEOUT=180000
KEEP_ALIVE_TIMEOUT=65000
EOF

# Create worker service script (placeholder - you'll need the actual worker application)
echo "Creating worker service template..."
sudo tee /opt/claude-worker/server.js > /dev/null <<'EOF'
// Tokyo Worker Service Template
// This is a placeholder - replace with actual worker application

const express = require('express');
const https = require('https');
const fs = require('fs');
const { spawn } = require('child_process');

const app = express();
const port = process.env.WORKER_PORT || 3003;

// Middleware
app.use(express.json({ limit: '10mb' }));

// Authentication middleware
const authenticateAPI = (req, res, next) => {
    const authHeader = req.headers.authorization;
    const expectedKey = process.env.WORKER_API_KEY;
    
    if (!authHeader || !authHeader.startsWith('Bearer ') || authHeader.slice(7) !== expectedKey) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    // Check allowed coordinators
    const clientIP = req.ip || req.connection.remoteAddress;
    const allowedIPs = (process.env.ALLOWED_COORDINATORS || '').split(',');
    
    if (!allowedIPs.includes(clientIP)) {
        console.warn(`Rejected request from unauthorized IP: ${clientIP}`);
        return res.status(403).json({ error: 'Forbidden' });
    }
    
    next();
};

// Health check endpoint
app.get('/health', authenticateAPI, (req, res) => {
    res.json({
        status: 'healthy',
        worker: {
            id: process.env.WORKER_ID,
            region: process.env.WORKER_REGION,
            capabilities: (process.env.WORKER_CAPABILITIES || '').split(','),
            uptime: process.uptime(),
            memory: process.memoryUsage(),
            timestamp: new Date().toISOString()
        },
        system: {
            loadAverage: require('os').loadavg()[0],
            memoryUsage: (process.memoryUsage().rss / (1024 * 1024 * 1024)) * 100,
            cpuUsage: 0 // Would need actual CPU monitoring
        },
        jobs: {
            active: 0, // Would track actual active jobs
            maxConcurrent: parseInt(process.env.WORKER_MAX_CONCURRENT_JOBS || '5')
        }
    });
});

// Job execution endpoint
app.post('/api/worker/execute', authenticateAPI, async (req, res) => {
    const { jobId, type, payload, timeout = 120000 } = req.body;
    
    console.log(`Executing job ${jobId} of type ${type}`);
    
    try {
        // This is where you'd implement actual job execution
        // For now, just return a mock result
        const result = {
            jobId,
            success: true,
            result: `Mock result for ${type} job`,
            executedAt: new Date().toISOString(),
            duration: Math.random() * 1000 + 500 // Mock duration
        };
        
        // Simulate work
        await new Promise(resolve => setTimeout(resolve, 100));
        
        res.json(result);
        
    } catch (error) {
        console.error(`Job ${jobId} failed:`, error);
        res.status(500).json({
            jobId,
            success: false,
            error: error.message,
            executedAt: new Date().toISOString()
        });
    }
});

// Metrics endpoint
app.get('/api/metrics', authenticateAPI, (req, res) => {
    res.json({
        system: {
            uptime: process.uptime(),
            memory: process.memoryUsage(),
            loadAverage: require('os').loadavg(),
            platform: process.platform,
            nodeVersion: process.version
        },
        worker: {
            activeJobs: 0,
            completedJobs: 0,
            failedJobs: 0,
            avgResponseTime: 0
        },
        timestamp: new Date().toISOString()
    });
});

// Start server
if (process.env.ENABLE_HTTPS === 'true') {
    const options = {
        key: fs.readFileSync(process.env.SSL_KEY_PATH),
        cert: fs.readFileSync(process.env.SSL_CERT_PATH)
    };
    
    https.createServer(options, app).listen(port, () => {
        console.log(`Tokyo Worker ${process.env.WORKER_ID} running on HTTPS port ${port}`);
        console.log(`Coordinator: ${process.env.COORDINATOR_IP}`);
        console.log(`Capabilities: ${process.env.WORKER_CAPABILITIES}`);
    });
} else {
    app.listen(port, () => {
        console.log(`Tokyo Worker ${process.env.WORKER_ID} running on HTTP port ${port}`);
    });
}

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('Received SIGTERM, shutting down gracefully');
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('Received SIGINT, shutting down gracefully');
    process.exit(0);
});
EOF

# Create PM2 ecosystem file
echo "Creating PM2 configuration..."
sudo tee /opt/claude-worker/ecosystem.config.js > /dev/null <<EOF
module.exports = {
  apps: [{
    name: 'tokyo-claude-worker',
    script: 'server.js',
    cwd: '/opt/claude-worker',
    env_file: '/etc/claude-worker/.env',
    instances: 1,
    exec_mode: 'cluster',
    max_memory_restart: '2G',
    error_file: '/var/log/claude-worker/error.log',
    out_file: '/var/log/claude-worker/out.log',
    log_file: '/var/log/claude-worker/combined.log',
    time: true,
    autorestart: true,
    max_restarts: 10,
    min_uptime: '10s',
    kill_timeout: 5000,
    listen_timeout: 8000,
    env: {
      NODE_ENV: 'production'
    }
  }]
};
EOF

# Set permissions
sudo chown -R claude-worker:claude-worker /opt/claude-worker
sudo chmod +x /opt/claude-worker/server.js

# Install dependencies (basic Express setup)
cd /opt/claude-worker
sudo -u claude-worker npm init -y
sudo -u claude-worker npm install express

# Create systemd service for auto-start
echo "Creating systemd service..."
sudo tee /etc/systemd/system/claude-worker.service > /dev/null <<EOF
[Unit]
Description=Claude Tokyo Worker
After=network.target

[Service]
Type=forking
User=claude-worker
WorkingDirectory=/opt/claude-worker
Environment=PATH=/usr/bin:/usr/local/bin
Environment=NODE_ENV=production
ExecStart=/usr/local/bin/pm2 start ecosystem.config.js --env production
ExecReload=/usr/local/bin/pm2 restart tokyo-claude-worker
ExecStop=/usr/local/bin/pm2 stop tokyo-claude-worker
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable claude-worker

# Setup log rotation
echo "Setting up log rotation..."
sudo tee /etc/logrotate.d/claude-worker > /dev/null <<EOF
/var/log/claude-worker/*.log {
    daily
    missingok
    rotate 7
    compress
    delaycompress
    notifempty
    create 644 claude-worker claude-worker
    postrotate
        sudo systemctl reload claude-worker
    endscript
}
EOF

# Create test script
echo "Creating test script..."
sudo tee /opt/claude-worker/test-connection.sh > /dev/null <<EOF
#!/bin/bash
echo "Testing Tokyo worker connection..."
echo "Worker API Key: $WORKER_API_KEY"
echo "Coordinator IP: $COORDINATOR_IP"

# Test health endpoint
curl -k -H "Authorization: Bearer $WORKER_API_KEY" \\
  https://localhost:$WORKER_PORT/health

echo ""
echo "Test from coordinator (run this from $COORDINATOR_IP):"
echo "curl -H \"Authorization: Bearer $WORKER_API_KEY\" https://$(curl -s ifconfig.me):$WORKER_PORT/health"
EOF

sudo chmod +x /opt/claude-worker/test-connection.sh
sudo chown claude-worker:claude-worker /opt/claude-worker/test-connection.sh

# Start the service
echo "Starting Claude worker service..."
sudo systemctl start claude-worker

# Display status
sleep 5
sudo systemctl status claude-worker --no-pager

echo ""
echo "=== Tokyo Worker Setup Complete ==="
echo "Worker ID: tokyo-$(hostname)"
echo "API Key: $WORKER_API_KEY"
echo "Port: $WORKER_PORT"
echo "Coordinator: $COORDINATOR_IP"
echo ""
echo "Next steps:"
echo "1. Test connection: sudo -u claude-worker /opt/claude-worker/test-connection.sh"
echo "2. Check logs: sudo journalctl -u claude-worker -f"
echo "3. Add this worker to your coordinator's TOKYO_WORKERS environment variable:"
echo "   worker-$(hostname):$(curl -s ifconfig.me):$WORKER_PORT:context7|general:$WORKER_API_KEY"
echo ""
echo "Security reminder:"
echo "- Only $COORDINATOR_IP can access this worker"
echo "- API key authentication is required"
echo "- HTTPS/TLS is enabled with self-signed certificate"
EOF