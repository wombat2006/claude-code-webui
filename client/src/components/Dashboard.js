import React, { useState, useEffect } from 'react';
import './Dashboard.css';

const Dashboard = ({ socket, isConnected }) => {
  const [metrics, setMetrics] = useState({
    system: { rss: 0, cpu: 0, memory: 0 },
    llm: {},
    rag: { hits: 0, totalSearches: 0, lastUpdated: null },
    session: { requests: 0, tokens: 0, cost: 0 },
    daily: { requests: 0, tokens: 0, cost: 0 }
  });
  
  const [isVisible, setIsVisible] = useState(false);
  const [autoUpdate, setAutoUpdate] = useState(true);

  useEffect(() => {
    if (!socket || !isConnected) return;

    // Listen for event-driven updates
    socket.on('metrics:llm_complete', (data) => {
      setMetrics(prev => ({
        ...prev,
        session: {
          requests: prev.session.requests + 1,
          tokens: prev.session.tokens + (data.tokens || 0),
          cost: prev.session.cost + (data.cost || 0)
        },
        daily: {
          requests: prev.daily.requests + 1,
          tokens: prev.daily.tokens + (data.tokens || 0),
          cost: prev.daily.cost + (data.cost || 0)
        }
      }));
    });

    // Listen for RAG search events
    socket.on('metrics:rag_search', (data) => {
      setMetrics(prev => ({
        ...prev,
        rag: {
          hits: data.results > 0 ? prev.rag.hits + 1 : prev.rag.hits,
          totalSearches: prev.rag.totalSearches + 1,
          lastUpdated: new Date().toLocaleTimeString()
        }
      }));
    });

    // Listen for LLM health updates (only when status changes)
    socket.on('metrics:llm_health', (data) => {
      setMetrics(prev => ({
        ...prev,
        llm: {
          ...prev.llm,
          [data.model]: {
            status: data.status,
            latency: data.latency,
            lastCheck: new Date().toLocaleTimeString()
          }
        }
      }));
    });

    // System stats - low frequency updates (every 10-30 seconds)
    socket.on('metrics:system', (data) => {
      if (autoUpdate) {
        setMetrics(prev => ({
          ...prev,
          system: {
            rss: data.rss || 0,
            cpu: data.cpu || 0,
            memory: data.memory || 0,
            lastUpdated: new Date().toLocaleTimeString()
          }
        }));
      }
    });

    return () => {
      socket.off('metrics:llm_complete');
      socket.off('metrics:rag_search');
      socket.off('metrics:llm_health');
      socket.off('metrics:system');
    };
  }, [socket, isConnected, autoUpdate]);

  const refreshSystemStats = () => {
    if (socket && isConnected) {
      socket.emit('metrics:request_system');
    }
  };

  const getStatusIndicator = (status) => {
    switch (status) {
      case 'healthy': return '🟢';
      case 'degraded': return '🟡';
      case 'unhealthy': return '🔴';
      default: return '⚪';
    }
  };

  if (!isVisible) {
    return (
      <div className="dashboard-toggle">
        <button onClick={() => setIsVisible(true)}>
          📊 Show Dashboard
        </button>
      </div>
    );
  }

  return (
    <div className="dashboard">
      <div className="dashboard-header">
        <h3>📊 System Dashboard</h3>
        <div className="dashboard-controls">
          <label>
            <input 
              type="checkbox" 
              checked={autoUpdate}
              onChange={(e) => setAutoUpdate(e.target.checked)}
            />
            Auto-update
          </label>
          <button onClick={refreshSystemStats}>🔄 Refresh</button>
          <button onClick={() => setIsVisible(false)}>✕</button>
        </div>
      </div>

      <div className="dashboard-grid">
        {/* System Resources */}
        <div className="metric-card">
          <h4>🖥️ System</h4>
          <div className="metric-item">
            <span>Memory:</span> 
            <span>{metrics.system.rss}MB RSS</span>
          </div>
          <div className="metric-item">
            <span>CPU:</span> 
            <span>{metrics.system.cpu}%</span>
          </div>
          <div className="metric-item small">
            Updated: {metrics.system.lastUpdated || 'Never'}
          </div>
        </div>

        {/* LLM Health */}
        <div className="metric-card">
          <h4>🤖 LLM Models</h4>
          {Object.entries(metrics.llm).length === 0 ? (
            <div className="metric-item">No models checked yet</div>
          ) : (
            Object.entries(metrics.llm).map(([model, data]) => (
              <div key={model} className="metric-item">
                <span>{getStatusIndicator(data.status)} {model}:</span>
                <span>{data.latency}ms</span>
              </div>
            ))
          )}
        </div>

        {/* RAG Status */}
        <div className="metric-card">
          <h4>📚 RAG Search</h4>
          <div className="metric-item">
            <span>Hit Rate:</span>
            <span>
              {metrics.rag.totalSearches > 0 
                ? `${Math.round((metrics.rag.hits / metrics.rag.totalSearches) * 100)}%`
                : 'N/A'
              }
            </span>
          </div>
          <div className="metric-item">
            <span>Total Searches:</span>
            <span>{metrics.rag.totalSearches}</span>
          </div>
          <div className="metric-item small">
            Last: {metrics.rag.lastUpdated || 'Never'}
          </div>
        </div>

        {/* Session Stats */}
        <div className="metric-card">
          <h4>📊 Session</h4>
          <div className="metric-item">
            <span>Requests:</span>
            <span>{metrics.session.requests}</span>
          </div>
          <div className="metric-item">
            <span>Tokens:</span>
            <span>{metrics.session.tokens.toLocaleString()}</span>
          </div>
          <div className="metric-item">
            <span>Cost:</span>
            <span>${metrics.session.cost.toFixed(4)}</span>
          </div>
        </div>

        {/* Daily Totals */}
        <div className="metric-card">
          <h4>📈 Daily Total</h4>
          <div className="metric-item">
            <span>Requests:</span>
            <span>{metrics.daily.requests}</span>
          </div>
          <div className="metric-item">
            <span>Tokens:</span>
            <span>{metrics.daily.tokens.toLocaleString()}</span>
          </div>
          <div className="metric-item">
            <span>Cost:</span>
            <span>${metrics.daily.cost.toFixed(4)}</span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Dashboard;