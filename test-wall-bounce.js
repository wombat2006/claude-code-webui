#!/usr/bin/env node

const { io } = require('socket.io-client');

// Test Wall-bounce functionality via HTTPS WebSocket
console.log('🧪 Testing Wall-bounce functionality...\n');

const socket = io('https://techsapo.com', {
  path: '/socket.io',
  transports: ['websocket', 'polling'],
  secure: true,
  rejectUnauthorized: false // Allow self-signed certs for testing
});

socket.on('connect', () => {
  console.log('✅ Connected to HTTPS WebSocket server');
  console.log('Socket ID:', socket.id);
  
  // Test Wall-bounce collaboration
  const testQuery = 'Azure Oracle のクエリ実行速度が遅い問題について、TPU設定を含めて総合的に分析してください。';
  
  const collaborationRequest = {
    query: testQuery,
    taskType: 'analysis',
    models: ['gpt-5', 'gemini-2.5-pro', 'o3-mini'],
    sessionId: `test-${Date.now()}`
  };
  
  console.log('\n🚀 Starting Wall-bounce collaboration...');
  console.log('Query:', testQuery);
  console.log('Models:', collaborationRequest.models);
  console.log('Session ID:', collaborationRequest.sessionId);
  
  socket.emit('llm:start_collaboration', collaborationRequest);
});

socket.on('connect_error', (error) => {
  console.error('❌ Connection error:', error.message);
  process.exit(1);
});

socket.on('llm:collaboration_complete', (data) => {
  console.log('\n🎉 Wall-bounce collaboration completed!');
  console.log('Wall-bounce count:', data.wallBounceCount);
  console.log('Processing time:', data.metadata?.processingTime || 'N/A', 'ms');
  console.log('Successful models:', data.metadata?.successfulModels?.join(', ') || 'N/A');
  
  if (data.metadata?.failedModels?.length > 0) {
    console.log('Failed models:', data.metadata.failedModels.join(', '));
  }
  
  console.log('\n📋 Final Response Preview:');
  console.log(data.finalResponse?.substring(0, 300) + '...');
  
  console.log('\n✅ Test completed successfully!');
  socket.disconnect();
  process.exit(0);
});

socket.on('llm:collaboration_error', (error) => {
  console.error('❌ Collaboration error:', error.error);
  socket.disconnect();
  process.exit(1);
});

socket.on('disconnect', () => {
  console.log('🔌 Disconnected from server');
});

// Timeout after 60 seconds
setTimeout(() => {
  console.log('⏰ Test timeout after 60 seconds');
  socket.disconnect();
  process.exit(1);
}, 60000);

console.log('🔗 Connecting to https://techsapo.com...');