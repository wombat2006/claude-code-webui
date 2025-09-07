const io = require('socket.io-client');

// Socket.IOクライアント接続
const socket = io('http://localhost:3004');

console.log('Socket.IOクライアント開始...');

socket.on('connect', () => {
    console.log('✅ サーバーに接続しました');
    
    // テストイベント送信
    console.log('📊 メトリクステストを開始します...');
    
    // 1. LLMリクエストのシミュレート
    console.log('\n1. LLMリクエストのシミュレート:');
    socket.emit('test:simulate_llm', {
        sessionId: 'test-session-metrics',
        model: 'claude-4',
        tokens: 1024,
        cost: 0.003,
        latency: 1500,
        success: true
    });
    
    // 2. RAG検索のシミュレート
    setTimeout(() => {
        console.log('\n2. RAG検索のシミュレート:');
        socket.emit('test:simulate_rag', {
            sessionId: 'test-session-metrics',
            query: 'dashboard metrics test',
            results: [{id: 1, title: 'Test Document'}],
            processingTime: 250
        });
    }, 1000);
    
    // 3. システム統計リクエスト
    setTimeout(() => {
        console.log('\n3. システム統計のリクエスト:');
        socket.emit('metrics:request_system');
    }, 2000);
    
    // 4. 複数のリクエストシミュレート
    setTimeout(() => {
        console.log('\n4. 複数リクエストのシミュレート:');
        for (let i = 0; i < 3; i++) {
            socket.emit('test:simulate_llm', {
                sessionId: `test-session-${i}`,
                model: ['claude-4', 'gpt-5', 'gemini-2.5-pro'][i],
                tokens: Math.floor(Math.random() * 1000) + 500,
                cost: Math.random() * 0.01,
                latency: Math.floor(Math.random() * 1000) + 800,
                success: Math.random() > 0.1
            });
        }
    }, 3000);
});

// イベントリスナー
socket.on('metrics:system', (data) => {
    console.log('📈 システム統計:', {
        rss: `${data.rss}MB`,
        cpu: `${data.cpu}%`,
        lastUpdated: data.lastUpdated
    });
});

socket.on('metrics:llm_complete', (data) => {
    console.log('🤖 LLM完了:', {
        model: data.model,
        tokens: data.tokens,
        cost: `$${data.cost}`,
        latency: `${data.latency}ms`,
        success: data.success
    });
});

socket.on('metrics:rag_search', (data) => {
    console.log('📚 RAG検索:', {
        results: data.results,
        processingTime: `${data.processingTime}ms`,
        hasResults: data.hasResults
    });
});

socket.on('metrics:llm_health', (data) => {
    console.log('💊 LLMヘルス:', {
        model: data.model,
        status: data.status,
        latency: `${data.latency}ms`,
        successRate: data.successRate ? `${data.successRate}%` : 'N/A'
    });
});

socket.on('disconnect', () => {
    console.log('❌ サーバーから切断されました');
});

socket.on('connect_error', (error) => {
    console.error('🔥 接続エラー:', error.message);
});

// 10秒後にクライアント終了
setTimeout(() => {
    console.log('\n✅ テスト完了、接続を終了します');
    socket.disconnect();
    process.exit(0);
}, 8000);