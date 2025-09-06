#!/bin/bash

# Test Tokyo Worker Connection from Coordinator (54.65.178.168)
# Run this script from your main VM to test Tokyo worker connectivity

COORDINATOR_IP="54.65.178.168"
TOKYO_WORKERS="${TOKYO_WORKERS:-}"

if [ -z "$TOKYO_WORKERS" ]; then
    echo "Please set TOKYO_WORKERS environment variable:"
    echo "export TOKYO_WORKERS=\"worker1:tokyo-vm1.techsapo.com:3003:context7|general:api-key-1\""
    exit 1
fi

echo "=== Testing Tokyo Worker Connections from $COORDINATOR_IP ==="
echo ""

# Parse and test each worker
IFS=',' read -ra WORKERS <<< "$TOKYO_WORKERS"
for worker_config in "${WORKERS[@]}"; do
    IFS=':' read -ra CONFIG <<< "$worker_config"
    worker_name="${CONFIG[0]}"
    worker_host="${CONFIG[1]}"  
    worker_port="${CONFIG[2]}"
    worker_capabilities="${CONFIG[3]}"
    worker_api_key="${CONFIG[4]}"
    
    echo "Testing worker: $worker_name"
    echo "Host: $worker_host:$worker_port"
    echo "Capabilities: $worker_capabilities"
    echo ""
    
    # Test network connectivity
    echo "1. Testing network connectivity..."
    if timeout 5 bash -c "echo >/dev/tcp/$worker_host/$worker_port"; then
        echo "   ✓ Network connection successful"
    else
        echo "   ✗ Network connection failed"
        echo "   Check: firewall, worker service, network routing"
        continue
    fi
    
    # Test health endpoint
    echo "2. Testing health endpoint..."
    health_response=$(curl -s -k --max-time 10 \
        -H "Authorization: Bearer $worker_api_key" \
        "https://$worker_host:$worker_port/health" 2>/dev/null)
    
    if [ $? -eq 0 ] && echo "$health_response" | jq -e '.status' >/dev/null 2>&1; then
        echo "   ✓ Health check successful"
        echo "   Worker status: $(echo "$health_response" | jq -r '.status')"
        echo "   Worker ID: $(echo "$health_response" | jq -r '.worker.id')"
        echo "   Uptime: $(echo "$health_response" | jq -r '.worker.uptime')s"
    else
        echo "   ✗ Health check failed"
        echo "   Response: $health_response"
        echo "   Check: API key, worker service, SSL certificate"
        continue
    fi
    
    # Test job execution
    echo "3. Testing job execution..."
    test_job=$(curl -s -k --max-time 30 \
        -H "Authorization: Bearer $worker_api_key" \
        -H "Content-Type: application/json" \
        -X POST "https://$worker_host:$worker_port/api/worker/execute" \
        -d '{
            "jobId": "test-'$(date +%s)'",
            "type": "test",
            "payload": {"message": "Hello from coordinator"},
            "timeout": 10000
        }' 2>/dev/null)
    
    if [ $? -eq 0 ] && echo "$test_job" | jq -e '.success' >/dev/null 2>&1; then
        echo "   ✓ Job execution successful"
        echo "   Duration: $(echo "$test_job" | jq -r '.duration')ms"
    else
        echo "   ✗ Job execution failed"
        echo "   Response: $test_job"
    fi
    
    # Test metrics endpoint
    echo "4. Testing metrics endpoint..."
    metrics_response=$(curl -s -k --max-time 10 \
        -H "Authorization: Bearer $worker_api_key" \
        "https://$worker_host:$worker_port/api/metrics" 2>/dev/null)
    
    if [ $? -eq 0 ] && echo "$metrics_response" | jq -e '.system' >/dev/null 2>&1; then
        echo "   ✓ Metrics endpoint successful"
        load_avg=$(echo "$metrics_response" | jq -r '.system.loadAverage[0]' 2>/dev/null || echo "N/A")
        memory_mb=$(echo "$metrics_response" | jq -r '.system.memory.rss' 2>/dev/null | awk '{print int($1/1024/1024)}')
        echo "   Load average: $load_avg"
        echo "   Memory usage: ${memory_mb}MB"
    else
        echo "   ✗ Metrics endpoint failed"
        echo "   Response: $metrics_response"
    fi
    
    echo ""
    echo "----------------------------------------"
    echo ""
done

# Test load balancer integration
echo "=== Testing Load Balancer Integration ==="
echo ""

# Check if main VM can route jobs to Tokyo workers
echo "Testing workload distribution..."

# Simulate high local load to trigger Tokyo routing
curl -s -X POST "http://localhost:3001/api/workers/simulate-load" \
    -H "Content-Type: application/json" \
    -d '{"simulate": true, "localLoad": 0.9}' >/dev/null 2>&1

# Submit a test job that should route to Tokyo
test_result=$(curl -s -X POST "http://localhost:3001/api/context7/resolve" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $(grep JWT_SECRET .env | cut -d= -f2)" \
    -d '{"query": "react"}' 2>/dev/null)

if echo "$test_result" | jq -e '.distributed' >/dev/null 2>&1; then
    if [ "$(echo "$test_result" | jq -r '.distributed')" = "true" ]; then
        echo "✓ Job successfully distributed to remote worker"
    else
        echo "○ Job processed locally (normal if Tokyo workers busy)"
    fi
else
    echo "✗ Failed to test job distribution"
fi

# Reset simulation
curl -s -X POST "http://localhost:3001/api/workers/simulate-load" \
    -H "Content-Type: application/json" \
    -d '{"simulate": false}' >/dev/null 2>&1

echo ""
echo "=== Connection Test Summary ==="
echo ""

# Get worker statistics
worker_stats=$(curl -s "http://localhost:3001/api/workers/tokyo/stats" 2>/dev/null)
if [ $? -eq 0 ] && echo "$worker_stats" | jq -e '.totalWorkers' >/dev/null 2>&1; then
    total_workers=$(echo "$worker_stats" | jq -r '.totalWorkers')
    online_workers=$(echo "$worker_stats" | jq -r '.onlineWorkers')
    avg_response=$(echo "$worker_stats" | jq -r '.avgResponseTime')
    
    echo "Total Tokyo workers: $total_workers"
    echo "Online workers: $online_workers"
    echo "Average response time: ${avg_response}ms"
    echo ""
    
    if [ "$online_workers" -eq "$total_workers" ] && [ "$total_workers" -gt 0 ]; then
        echo "🎉 All Tokyo workers are online and ready!"
    elif [ "$online_workers" -gt 0 ]; then
        echo "⚠️  Some Tokyo workers are offline ($online_workers/$total_workers online)"
    else
        echo "❌ No Tokyo workers are online"
    fi
else
    echo "❌ Could not retrieve worker statistics"
fi

echo ""
echo "Configuration for .env file:"
echo "TOKYO_WORKERS=$TOKYO_WORKERS"
echo ""
echo "Firewall check from Tokyo workers should allow:"
echo "sudo ufw allow from $COORDINATOR_IP to any port 3003"