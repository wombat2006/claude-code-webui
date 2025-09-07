import React, { useState, useEffect, useRef } from 'react';
import './LLMCollaboration.css';

const LLMCollaboration = ({ socket, isConnected }) => {
  const [isVisible, setIsVisible] = useState(false);
  const [query, setQuery] = useState('');
  const [taskType, setTaskType] = useState('general');
  const [selectedModels, setSelectedModels] = useState(['gpt-5', 'gemini-2.5-pro', 'o3-mini']);
  const [isProcessing, setIsProcessing] = useState(false);
  const [collaborationResult, setCollaborationResult] = useState(null);
  const [collaborationHistory, setCollaborationHistory] = useState([]);
  const [showInternalConversation, setShowInternalConversation] = useState(false);
  const resultRef = useRef(null);

  const availableModels = [
    { id: 'gpt-5', name: 'GPT-5', description: '技術的分析・コーディング専用' },
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', description: '実践的アプローチ・運用管理' },
    { id: 'o3-mini', name: 'O3-Mini', description: '論理的思考・費用対効果分析' },
    { id: 'gpt-4.1', name: 'GPT-4.1', description: '汎用分析・文書作成' }
  ];

  const taskTypes = [
    { id: 'general', name: '一般的な質問', description: '技術的・業務的な一般質問' },
    { id: 'coding', name: 'コーディング', description: 'プログラミング・開発関連' },
    { id: 'analysis', name: '分析・診断', description: 'システム分析・問題診断' },
    { id: 'architecture', name: 'アーキテクチャ', description: 'システム設計・構成検討' }
  ];

  useEffect(() => {
    if (!socket || !isConnected) return;

    socket.on('llm:collaboration_complete', (data) => {
      setIsProcessing(false);
      setCollaborationResult(data);
      setCollaborationHistory(prev => [data, ...prev]);
      
      // スクロール to result
      if (resultRef.current) {
        resultRef.current.scrollIntoView({ behavior: 'smooth' });
      }
    });

    socket.on('llm:collaboration_error', (data) => {
      setIsProcessing(false);
      alert(`エラーが発生しました: ${data.error}`);
    });

    return () => {
      socket.off('llm:collaboration_complete');
      socket.off('llm:collaboration_error');
    };
  }, [socket, isConnected]);

  const handleModelToggle = (modelId) => {
    if (selectedModels.includes(modelId)) {
      setSelectedModels(selectedModels.filter(id => id !== modelId));
    } else {
      setSelectedModels([...selectedModels, modelId]);
    }
  };

  const startCollaboration = () => {
    if (!query.trim() || selectedModels.length < 2 || !socket || isProcessing) {
      return;
    }

    setIsProcessing(true);
    setCollaborationResult(null);

    const collaborationRequest = {
      query: query.trim(),
      taskType,
      models: selectedModels,
      sessionId: `webui-${Date.now()}`
    };

    socket.emit('llm:start_collaboration', collaborationRequest);
  };

  const formatTimestamp = (timestamp) => {
    return new Date(timestamp).toLocaleString('ja-JP');
  };

  const getModelEmoji = (model) => {
    const emojiMap = {
      'gpt-5': '🧠',
      'gemini-2.5-pro': '⭐',
      'o3-mini': '🔬',
      'gpt-4.1': '📝'
    };
    return emojiMap[model] || '🤖';
  };

  if (!isVisible) {
    return (
      <div className="collaboration-toggle">
        <button onClick={() => setIsVisible(true)} className="toggle-button">
          🤝 LLM複数協調動作（Wall-Bounce）
        </button>
      </div>
    );
  }

  return (
    <div className="llm-collaboration">
      <div className="collaboration-header">
        <h3>🤝 複数LLM協調動作（Wall-Bounce）</h3>
        <p>CLAUDE.mdに従った複数LLMによる壁打ち機能</p>
        <button onClick={() => setIsVisible(false)} className="close-button">✕</button>
      </div>

      <div className="collaboration-content">
        {/* Input Section */}
        <div className="input-section">
          <div className="query-input">
            <label>問い合わせ内容：</label>
            <textarea
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="例：Azure Oracle でクエリの実行速度が遅い問題について調査したい"
              rows={3}
              disabled={isProcessing}
            />
          </div>

          <div className="task-type-selection">
            <label>タスクタイプ：</label>
            <select 
              value={taskType} 
              onChange={(e) => setTaskType(e.target.value)}
              disabled={isProcessing}
            >
              {taskTypes.map(type => (
                <option key={type.id} value={type.id}>
                  {type.name} - {type.description}
                </option>
              ))}
            </select>
          </div>

          <div className="model-selection">
            <label>使用するLLMモデル（2つ以上選択）：</label>
            <div className="model-grid">
              {availableModels.map(model => (
                <div key={model.id} className="model-option">
                  <label>
                    <input
                      type="checkbox"
                      checked={selectedModels.includes(model.id)}
                      onChange={() => handleModelToggle(model.id)}
                      disabled={isProcessing}
                    />
                    <span className="model-info">
                      <strong>{getModelEmoji(model.id)} {model.name}</strong>
                      <br />
                      <small>{model.description}</small>
                    </span>
                  </label>
                </div>
              ))}
            </div>
          </div>

          <div className="action-buttons">
            <button 
              onClick={startCollaboration}
              disabled={!query.trim() || selectedModels.length < 2 || isProcessing}
              className="start-button"
            >
              {isProcessing ? '🔄 壁打ち実行中...' : '🚀 壁打ち開始'}
            </button>
            {selectedModels.length < 2 && (
              <small className="validation-error">※ 2つ以上のLLMモデルを選択してください</small>
            )}
          </div>
        </div>

        {/* Results Section */}
        {isProcessing && (
          <div className="processing-status">
            <div className="loading-spinner">🔄</div>
            <p>複数LLMによる協調動作を実行中...</p>
            <small>選択されたモデルとの壁打ちを順次実行しています</small>
          </div>
        )}

        {collaborationResult && (
          <div className="collaboration-result" ref={resultRef}>
            <div className="result-header">
              <h4>📋 壁打ち結果</h4>
              <div className="result-meta">
                <span>🕒 {formatTimestamp(collaborationResult.metadata.timestamp)}</span>
                <span>🔄 壁打ち回数: {collaborationResult.wallBounceCount}</span>
                <span>✅ 成功: {collaborationResult.metadata.successfulModels.join(', ')}</span>
                {collaborationResult.metadata.failedModels.length > 0 && (
                  <span className="failed-models">❌ 失敗: {collaborationResult.metadata.failedModels.join(', ')}</span>
                )}
              </div>
            </div>

            <div className="final-response">
              <h5>🎯 最終検証結果</h5>
              <div className="response-content">
                {collaborationResult.finalResponse.split('\n').map((line, index) => (
                  <p key={index}>{line}</p>
                ))}
              </div>
            </div>

            <div className="internal-conversation-toggle">
              <button 
                onClick={() => setShowInternalConversation(!showInternalConversation)}
                className="toggle-internal"
              >
                {showInternalConversation ? '🔽 内部会話を非表示' : '🔼 内部会話を表示'}
              </button>
            </div>

            {showInternalConversation && (
              <div className="internal-conversation">
                <h5>🗣️ 内部協調動作ログ</h5>
                {collaborationResult.collaborationHistory.map((step, index) => (
                  <div key={index} className={`collaboration-step ${step.error ? 'error' : 'success'}`}>
                    <div className="step-header">
                      <span className="step-number">Step {step.step}</span>
                      <span className="step-actor">{getModelEmoji(step.actor)} {step.actor}</span>
                      <span className="step-role">{step.role}</span>
                      <span className="step-time">{formatTimestamp(step.timestamp)}</span>
                    </div>
                    <div className="step-content">
                      <div className="step-output">
                        {step.output.substring(0, 500)}
                        {step.output.length > 500 && '...'}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* History Section */}
        {collaborationHistory.length > 0 && (
          <div className="collaboration-history">
            <h4>📚 過去の協調動作履歴</h4>
            {collaborationHistory.slice(0, 5).map((result, index) => (
              <div key={index} className="history-item">
                <div className="history-header">
                  <span className="history-query">
                    {result.originalQuery.substring(0, 100)}
                    {result.originalQuery.length > 100 && '...'}
                  </span>
                  <span className="history-time">{formatTimestamp(result.metadata.timestamp)}</span>
                </div>
                <div className="history-meta">
                  <span>壁打ち: {result.wallBounceCount}回</span>
                  <span>モデル: {result.metadata.successfulModels.join(', ')}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default LLMCollaboration;