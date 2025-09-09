#!/bin/bash

# Load test script for adaptive wall-bounce system
PORT=3002
BASE_URL="http://localhost:$PORT"

echo "🧪 Starting load test on optimized adaptive wall-bounce system"
echo "Server: $BASE_URL"
echo "Time: $(date)"
echo ""

# Function to send concurrent requests
send_concurrent_requests() {
    local prompt="$1"
    local count="$2"
    local batch_name="$3"
    
    echo "📊 Batch $batch_name: Sending $count concurrent requests..."
    
    # Create background requests
    for i in $(seq 1 $count); do
        {
            start_time=$(date +%s.%N)
            response=$(curl -s -X POST "$BASE_URL/openrouter/adaptive-wall-bounce" \
                -H "Content-Type: application/json" \
                -d "{\"prompt\": \"$prompt\", \"config\": {\"revisionThreshold\": 30}}")
            end_time=$(date +%s.%N)
            duration=$(echo "$end_time - $start_time" | bc -l)
            
            if echo "$response" | grep -q '"success":true'; then
                echo "✅ Request $i completed in ${duration}s"
            else
                echo "❌ Request $i failed: $(echo "$response" | head -c 100)..."
            fi
        } &
    done
    
    # Wait for all background processes to complete
    wait
    
    # Check memory after batch
    echo "💾 Memory check after batch $batch_name:"
    curl -s "$BASE_URL/memory" | jq -r '
        "  RSS: " + (.memory.rss/1024/1024|floor|tostring) + "MB" +
        "  Heap Used: " + (.memory.heapUsed/1024/1024|floor|tostring) + "MB" +
        "  Heap Total: " + (.memory.heapTotal/1024/1024|floor|tostring) + "MB"
    '
    echo ""
}

# Test 1: Light load (3 concurrent requests)
send_concurrent_requests "What is 5 + 5?" 3 "1-Light"
sleep 2

# Test 2: Medium load (5 concurrent requests)  
send_concurrent_requests "Explain the concept of machine learning." 5 "2-Medium"
sleep 3

# Test 3: Heavy load (8 concurrent requests)
send_concurrent_requests "What are the benefits of renewable energy?" 8 "3-Heavy"
sleep 3

# Test 4: Stress test (10 concurrent requests)
send_concurrent_requests "Describe the process of photosynthesis." 10 "4-Stress"
sleep 2

echo "🏁 Load test completed!"
echo "Time: $(date)"

# Final memory check
echo ""
echo "📊 Final system status:"
curl -s "$BASE_URL/memory" | jq '.'