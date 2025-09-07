/**
 * WebUI LLM Collaboration Service
 * Cipher MCP Server を使用した記憶の永続化機能付き複数LLM協調動作の実装
 * ユーザーセッション間での会話履歴と文脈の継続保持（Cipher MCPベースの記憶管理）
 */

const LLMCollaborationService = require('./llmCollaborationService');
const fs = require('fs').promises;
const path = require('path');

// Cipher MCP Client for memory persistence
class CipherMCPClient {
  constructor(options = {}) {
    this.cipherHost = options.cipherHost || 'localhost';
    this.cipherPort = options.cipherPort || 3001;
    this.timeout = options.timeout || 5000;
    this.connected = false;
    
    this.log = (message, data = {}) => {
      console.log(`[CipherMCP ${new Date().toISOString()}] ${message}`, JSON.stringify(data, null, 2));
    };
  }

  async connect() {
    try {
      // MCP接続の確認
      const response = await this.makeRequest('cipher_memory_search', { test: 'connection' });
      this.connected = true;
      this.log('Connected to Cipher MCP server successfully');
      return true;
    } catch (error) {
      this.log('Failed to connect to Cipher MCP server', { error: error.message });
      this.connected = false;
      return false;
    }
  }

  async makeRequest(method, params = {}) {
    if (!this.connected && method !== 'cipher_memory_search') {
      throw new Error('Cipher MCP client not connected');
    }

    try {
      // 実際のMCP通信実装（簡略化版）
      // 本来はMCPプロトコルに従った通信を行う
      const mcpRequest = {
        jsonrpc: '2.0',
        id: Date.now(),
        method: `tools/${method}`,
        params: {
          name: method,
          arguments: params
        }
      };

      // HTTP/WebSocket経由でCipherサーバーと通信
      const response = await fetch(`http://${this.cipherHost}:${this.cipherPort}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mcpRequest),
        timeout: this.timeout
      });

      if (!response.ok) {
        throw new Error(`Cipher MCP request failed: ${response.status}`);
      }

      const result = await response.json();
      return result.result || result;
    } catch (error) {
      this.log('Cipher MCP request error', { method, error: error.message });
      throw error;
    }
  }

  // メモリへの推論パターン保存
  async storeReasoningMemory(sessionId, data) {
    try {
      const result = await this.makeRequest('cipher_store_reasoning_memory', {
        sessionId,
        timestamp: new Date().toISOString(),
        data: {
          query: data.query,
          reasoning: data.reasoning,
          finalResponse: data.finalResponse,
          models: data.models,
          wallBounceCount: data.wallBounceCount,
          metadata: data.metadata
        }
      });
      
      this.log('Reasoning memory stored via Cipher', { sessionId, success: true });
      return result;
    } catch (error) {
      this.log('Failed to store reasoning memory', { sessionId, error: error.message });
      return null;
    }
  }

  // セッションメモリの検索
  async searchMemory(sessionId, query = '') {
    try {
      const result = await this.makeRequest('cipher_memory_search', {
        sessionId,
        query,
        maxResults: 5
      });
      
      this.log('Memory search completed via Cipher', { 
        sessionId, 
        query: query.substring(0, 100), 
        resultsCount: result?.memories?.length || 0 
      });
      
      return result;
    } catch (error) {
      this.log('Memory search failed', { sessionId, error: error.message });
      return null;
    }
  }

  // 知識の抽出と更新
  async extractAndOperateMemory(sessionId, operation) {
    try {
      const result = await this.makeRequest('cipher_extract_and_operate_memory', {
        sessionId,
        operation: {
          type: operation.type || 'update',
          data: operation.data,
          extractionRules: operation.extractionRules || []
        }
      });
      
      this.log('Memory extraction and operation completed', { sessionId, operationType: operation.type });
      return result;
    } catch (error) {
      this.log('Memory operation failed', { sessionId, error: error.message });
      return null;
    }
  }

  // ワークスペースメモリの保存
  async storeWorkspaceMemory(sessionId, workspaceData) {
    try {
      const result = await this.makeRequest('cipher_workspace_store', {
        sessionId,
        workspace: {
          userId: workspaceData.userId,
          collaborationType: workspaceData.collaborationType,
          teamSignals: workspaceData.teamSignals || [],
          projectContext: workspaceData.projectContext || {}
        }
      });
      
      this.log('Workspace memory stored via Cipher', { sessionId });
      return result;
    } catch (error) {
      this.log('Failed to store workspace memory', { sessionId, error: error.message });
      return null;
    }
  }

  // ワークスペースメモリの検索
  async searchWorkspaceMemory(sessionId, searchQuery) {
    try {
      const result = await this.makeRequest('cipher_workspace_search', {
        sessionId,
        query: searchQuery,
        includeTeamSignals: true
      });
      
      this.log('Workspace memory search completed', { sessionId });
      return result;
    } catch (error) {
      this.log('Workspace memory search failed', { sessionId, error: error.message });
      return null;
    }
  }
}

class WebUICollaborationService {
  constructor(options = {}) {
    this.collaborationService = new LLMCollaborationService(options);
    this.maxSessionHistory = options.maxSessionHistory || 50; // 最大50件の履歴を保持
    
    // Cipher MCP Client の初期化
    this.cipherClient = new CipherMCPClient({
      cipherHost: options.cipherHost || 'localhost',
      cipherPort: options.cipherPort || 3001,
      timeout: options.cipherTimeout || 5000
    });
    
    // Cipher MCP Memory System（永続化記憶管理システム）
    this.mcpMemory = {
      version: '1.0',
      protocol: 'cipher-mcp-memory',
      client: 'webui-collaboration',
      contextWindowSize: options.contextWindow || 10000, // トークン数の上限
      memoryRetentionDays: options.retentionDays || 30,
      vectorSearchEnabled: true,
      knowledgeGraphEnabled: true,
      sessionPersistenceEnabled: true
    };
    
    this.log = (message, data = {}) => {
      console.log(`[WebUICollaboration ${new Date().toISOString()}] ${message}`, JSON.stringify(data, null, 2));
    };

    // Cipher MCP接続の初期化
    this.initializeCipherConnection();
    
    this.log('WebUI LLM Collaboration Service initialized with Cipher MCP memory persistence');
  }

  /**
   * Cipher MCP接続の初期化
   */
  async initializeCipherConnection() {
    try {
      const connected = await this.cipherClient.connect();
      if (connected) {
        this.log('Cipher MCP connection established successfully');
        
        // 初期ワークスペース設定の保存
        await this.cipherClient.storeWorkspaceMemory('system-init', {
          userId: 'system',
          collaborationType: 'webui-multi-llm',
          teamSignals: ['wall-bounce', 'memory-persistence'],
          projectContext: {
            service: 'webui-collaboration',
            mcpVersion: this.mcpMemory.version,
            capabilities: ['reasoning-memory', 'workspace-memory', 'context-search']
          }
        });
      } else {
        this.log('Cipher MCP connection failed - falling back to local memory');
      }
    } catch (error) {
      this.log('Failed to initialize Cipher MCP connection', { error: error.message });
    }
  }

  /**
   * Cipher MCP - 協調動作データの最適化
   */
  optimizeCollaborationData(collaborationResult) {
    try {
      // Cipher MCPに最適化されたデータ構造
      const optimizedData = {
        query: collaborationResult.webui?.originalQuery || '',
        reasoning: {
          wallBounces: collaborationResult.wallBounceCount || 0,
          modelsUsed: collaborationResult.metadata?.successfulModels || [],
          processingTime: collaborationResult.metadata?.processingTime || 0,
          taskType: collaborationResult.taskType || 'general'
        },
        finalResponse: this.truncateText(collaborationResult.finalResponse, 2000),
        models: collaborationResult.metadata?.successfulModels || [],
        wallBounceCount: collaborationResult.wallBounceCount || 0,
        metadata: {
          timestamp: new Date().toISOString(),
          relatedTopics: collaborationResult.webui?.relatedTopics || [],
          keyInsights: this.extractKeyInsights(collaborationResult.finalResponse),
          success: collaborationResult.success || false
        }
      };
      
      return optimizedData;
    } catch (error) {
      this.log('Data optimization failed', { error: error.message });
      return collaborationResult;
    }
  }

  /**
   * 重要な洞察の抽出
   */
  extractKeyInsights(text) {
    if (!text) return [];
    
    const insights = [];
    const lines = text.split('\n');
    
    // 結論や推奨事項を含む行を抽出
    lines.forEach(line => {
      if (line.includes('結論') || line.includes('推奨') || 
          line.includes('重要') || line.includes('注意') ||
          line.includes('###') || line.includes('##')) {
        insights.push(line.trim());
      }
    });
    
    return insights.slice(0, 5); // 最大5つの洞察
  }

  /**
   * テキストの切り詰め
   */
  truncateText(text, maxLength) {
    if (!text || text.length <= maxLength) {
      return text;
    }
    return text.substring(0, maxLength) + '...';
  }

  /**
   * ユーザーセッションの履歴を読み込み（Cipher MCP経由）
   */
  async loadUserSessionHistory(userId) {
    try {
      // Cipher MCPからセッションメモリを検索
      const sessionMemory = await this.cipherClient.searchMemory(userId, 'user-session');
      
      if (sessionMemory && sessionMemory.memories && sessionMemory.memories.length > 0) {
        const sessionData = sessionMemory.memories[0].data;
        
        this.log('User session history loaded via Cipher MCP', { 
          userId, 
          collaborations: sessionData.collaborations?.length || 0,
          lastAccess: sessionData.lastAccessAt
        });
        
        return sessionData;
      }
    } catch (error) {
      this.log('Failed to load session history from Cipher MCP', { userId, error: error.message });
    }

    // セッションが見つからない場合は新しいセッションを作成
    this.log('Creating new Cipher MCP user session', { userId });
    const newSession = {
      userId,
      createdAt: new Date().toISOString(),
      lastAccessAt: new Date().toISOString(),
      collaborations: [],
      context: {
        preferences: {
          preferredModels: ['gpt-5', 'gemini-2.5-pro', 'o3-mini'],
          preferredTaskType: 'general'
        },
        domainKnowledge: [], // ユーザーの専門分野情報
        recentTopics: [] // 最近の話題
      },
      cipherMCP: {
        version: this.mcpMemory.version,
        protocol: this.mcpMemory.protocol,
        created: new Date().toISOString(),
        contextWindow: this.mcpMemory.contextWindowSize
      }
    };

    // 新しいセッションをCipher MCPに保存
    await this.saveUserSessionHistory(userId, newSession);
    return newSession;
  }

  /**
   * ユーザーセッションの履歴を保存（Cipher MCP経由）
   */
  async saveUserSessionHistory(userId, sessionData) {
    try {
      sessionData.lastAccessAt = new Date().toISOString();
      
      // 履歴数制限
      if (sessionData.collaborations && sessionData.collaborations.length > this.maxSessionHistory) {
        sessionData.collaborations = sessionData.collaborations.slice(-this.maxSessionHistory);
      }
      
      // Cipher MCPにワークスペースメモリとして保存
      await this.cipherClient.storeWorkspaceMemory(userId, {
        userId,
        collaborationType: 'user-session',
        teamSignals: ['session-history', 'context-persistence'],
        projectContext: sessionData
      });
      
      this.log('User session history saved via Cipher MCP', { 
        userId, 
        collaborations: sessionData.collaborations?.length || 0
      });
    } catch (error) {
      this.log('Failed to save user session history to Cipher MCP', { userId, error: error.message });
    }
  }

  /**
   * WebUI向けの複数LLM協調動作（記憶継続機能付き）
   */
  async processWebUICollaboration(request) {
    try {
      const { 
        query, 
        taskType = 'general', 
        models = ['gpt-5', 'gemini-2.5-pro', 'o3-mini'],
        sessionId,
        userId = 'anonymous',
        useMemory = true 
      } = request;

      this.log('Starting WebUI collaboration with memory', {
        userId,
        sessionId,
        taskType,
        queryLength: query.length,
        models,
        useMemory
      });

      // ユーザーセッション履歴の読み込み
      let userSession = null;
      let contextualQuery = query;

      if (useMemory) {
        userSession = await this.loadUserSessionHistory(userId);
        
        // 文脈情報の構築（Cipher MCPベース）
        const contextInfo = await this.buildContextualInformation(userSession, query, taskType);
        if (contextInfo) {
          contextualQuery = `${contextInfo}\n\n${query}`;
        }
      }

      // 基本的な協調動作実行
      const collaborationResult = await this.collaborationService.processCollaborativeQuery(contextualQuery, {
        sessionId,
        taskType,
        models
      });

      // 結果の拡張（WebUI用メタデータ追加）
      const webUIResult = {
        ...collaborationResult,
        webui: {
          originalQuery: query,
          contextualQuery,
          userId,
          memoryUsed: useMemory,
          relatedTopics: this.extractTopicsFromQuery(query),
          suggestedFollowups: this.generateFollowupSuggestions(query, collaborationResult)
        }
      };

      // ユーザーセッション履歴の更新とCipher MCPへの保存
      if (useMemory && userSession) {
        await this.updateUserSessionWithCollaboration(userId, userSession, webUIResult);
        
        // Cipher MCPに推論メモリとして保存
        const optimizedData = this.optimizeCollaborationData(webUIResult);
        await this.cipherClient.storeReasoningMemory(sessionId, optimizedData);
      }

      this.log('WebUI collaboration completed', {
        userId,
        sessionId,
        success: webUIResult.success,
        wallBounceCount: webUIResult.wallBounceCount
      });

      return webUIResult;

    } catch (error) {
      this.log('WebUI collaboration failed', { error: error.message });
      throw error;
    }
  }

  /**
   * 文脈情報の構築（Cipher MCPベース）
   */
  async buildContextualInformation(userSession, currentQuery, taskType) {
    try {
      // Cipher MCPからセマンティック検索で関連する過去の推論を取得
      const relevantMemories = await this.cipherClient.searchMemory(userSession.userId, currentQuery);
      
      let contextParts = [];
      
      // ユーザーセッション履歴からの文脈
      const recentCollaborations = userSession.collaborations.slice(-3); // 直近3件
      const sessionRelevantHistory = recentCollaborations.filter(collab => 
        this.isTopicRelevant(collab.webui?.originalQuery || '', currentQuery) ||
        collab.taskType === taskType
      );

      // Cipher MCPからの関連メモリ
      const cipherRelevantMemories = relevantMemories?.memories?.slice(0, 2) || []; // 最大2件

      if (sessionRelevantHistory.length === 0 && cipherRelevantMemories.length === 0) {
        return null;
      }

      contextParts = [
        '# 継続的な会話の文脈（Cipher MCP記憶統合）',
        ''
      ];

      // Cipher MCPからの関連記憶
      if (cipherRelevantMemories.length > 0) {
        contextParts.push('**過去の類似問題の解決例（Cipher MCP）:**');
        cipherRelevantMemories.forEach((memory, index) => {
          const memoryData = memory.data || {};
          contextParts.push(`### ${index + 1}. ${memoryData.query?.substring(0, 80) || 'N/A'}...`);
          contextParts.push(`**解決**: ${memoryData.finalResponse?.substring(0, 150) || 'N/A'}...`);
          contextParts.push(`**使用モデル**: ${memoryData.models?.join(', ') || 'N/A'}`);
          contextParts.push('');
        });
      }

      // セッション履歴からの文脈
      if (sessionRelevantHistory.length > 0) {
        contextParts.push('**現在セッションでの関連する質問:**');
        sessionRelevantHistory.forEach((collab, index) => {
          contextParts.push(`### ${index + 1}. ${collab.webui?.originalQuery?.substring(0, 80) || 'N/A'}...`);
          contextParts.push(`**結論**: ${collab.finalResponse?.substring(0, 150) || 'N/A'}...`);
          contextParts.push('');
        });
      }

      contextParts.push('**現在の質問**:');
      return contextParts.join('\n');

    } catch (error) {
      this.log('Failed to build contextual information from Cipher MCP', { error: error.message });
      
      // フォールバック：セッション履歴のみ使用
      const recentCollaborations = userSession.collaborations.slice(-5);
      const relevantHistory = recentCollaborations.filter(collab => 
        this.isTopicRelevant(collab.webui?.originalQuery || '', currentQuery) ||
        collab.taskType === taskType
      );

      if (relevantHistory.length === 0) {
        return null;
      }

      const contextParts = [
        '# 継続的な会話の文脈',
        '',
        '**過去の関連する質問と回答:**'
      ];

      relevantHistory.forEach((collab, index) => {
        contextParts.push(`## ${index + 1}. ${collab.webui?.originalQuery?.substring(0, 100) || 'N/A'}...`);
        contextParts.push(`**結論**: ${collab.finalResponse?.substring(0, 200) || 'N/A'}...`);
        contextParts.push('');
      });

      contextParts.push('**現在の質問**:');
      return contextParts.join('\n');
    }
  }

  /**
   * トピックの関連性判定
   */
  isTopicRelevant(previousQuery, currentQuery) {
    const previousKeywords = this.extractKeywords(previousQuery);
    const currentKeywords = this.extractKeywords(currentQuery);
    
    const commonKeywords = previousKeywords.filter(keyword => 
      currentKeywords.includes(keyword)
    );

    return commonKeywords.length >= 2; // 2つ以上の共通キーワードがあれば関連性あり
  }

  /**
   * キーワード抽出
   */
  extractKeywords(text) {
    // 簡易的なキーワード抽出
    const stopWords = ['の', 'で', 'を', 'に', 'は', 'が', 'と', 'する', 'である', 'について', 'から', 'まで'];
    const words = text.toLowerCase()
      .replace(/[^\w\s]/g, '')
      .split(/\s+/)
      .filter(word => word.length >= 3 && !stopWords.includes(word));
    
    return [...new Set(words)]; // 重複除去
  }

  /**
   * クエリからのトピック抽出
   */
  extractTopicsFromQuery(query) {
    const keywords = this.extractKeywords(query);
    
    // 技術関連キーワードのマッピング
    const topicMapping = {
      'oracle': 'Database',
      'azure': 'Cloud Platform',
      'performance': 'Performance Tuning',
      'query': 'SQL Optimization',
      'memory': 'Memory Management',
      'cpu': 'System Performance',
      'network': 'Network Configuration',
      'security': 'Security Analysis'
    };

    const topics = [];
    keywords.forEach(keyword => {
      if (topicMapping[keyword]) {
        topics.push(topicMapping[keyword]);
      }
    });

    return [...new Set(topics)]; // 重複除去
  }

  /**
   * フォローアップ提案の生成
   */
  generateFollowupSuggestions(originalQuery, collaborationResult) {
    const suggestions = [];
    
    // 成功したモデルの数に基づく提案
    if (collaborationResult.metadata.successfulModels.length >= 3) {
      suggestions.push('より詳細な実装手順について質問する');
      suggestions.push('関連する別の技術課題について相談する');
    }

    // クエリの内容に基づく提案
    if (originalQuery.toLowerCase().includes('performance') || originalQuery.includes('性能')) {
      suggestions.push('性能監視の継続的な方法について確認する');
      suggestions.push('同様の問題を予防する方法を相談する');
    }

    if (originalQuery.toLowerCase().includes('error') || originalQuery.includes('エラー')) {
      suggestions.push('エラーの根本原因分析を深掘りする');
      suggestions.push('同様のエラーの監視方法を確認する');
    }

    return suggestions.slice(0, 3); // 最大3つの提案
  }

  /**
   * ユーザーセッションに協調動作結果を追加
   */
  async updateUserSessionWithCollaboration(userId, userSession, collaborationResult) {
    // 新しい協調動作結果を追加
    userSession.collaborations.push({
      timestamp: new Date().toISOString(),
      sessionId: collaborationResult.metadata.sessionId,
      taskType: collaborationResult.taskType,
      originalQuery: collaborationResult.webui.originalQuery,
      finalResponse: collaborationResult.finalResponse,
      wallBounceCount: collaborationResult.wallBounceCount,
      successfulModels: collaborationResult.metadata.successfulModels,
      relatedTopics: collaborationResult.webui.relatedTopics,
      webui: collaborationResult.webui
    });

    // ユーザーのコンテキスト情報を更新
    this.updateUserContext(userSession, collaborationResult);

    // セッション履歴を保存
    await this.saveUserSessionHistory(userId, userSession);
  }

  /**
   * ユーザーコンテキストの更新
   */
  updateUserContext(userSession, collaborationResult) {
    const context = userSession.context;

    // 最近のトピックを更新
    const newTopics = collaborationResult.webui.relatedTopics;
    context.recentTopics = [...new Set([...newTopics, ...context.recentTopics])].slice(0, 10);

    // 使用したモデルの学習（成功したモデルを優先）
    const successfulModels = collaborationResult.metadata.successfulModels;
    if (successfulModels.length >= 2) {
      context.preferences.preferredModels = successfulModels;
    }

    // タスクタイプの学習
    context.preferences.preferredTaskType = collaborationResult.taskType;
  }

  /**
   * ユーザーの協調動作履歴を取得
   */
  async getUserCollaborationHistory(userId, limit = 10) {
    try {
      const userSession = await this.loadUserSessionHistory(userId);
      return {
        userId,
        totalCollaborations: userSession.collaborations.length,
        recentCollaborations: userSession.collaborations.slice(-limit).reverse(),
        context: userSession.context,
        lastAccessAt: userSession.lastAccessAt
      };
    } catch (error) {
      this.log('Failed to get user collaboration history', { userId, error: error.message });
      return {
        userId,
        totalCollaborations: 0,
        recentCollaborations: [],
        context: null,
        lastAccessAt: null
      };
    }
  }

  /**
   * ユーザーのコンテキストをリセット（Cipher MCP経由）
   */
  async resetUserContext(userId) {
    try {
      // Cipher MCPでワークスペースメモリを削除
      const deleted = await this.cipherClient.delete(`user-${userId}`);
      
      if (deleted) {
        this.log('User context reset via Cipher MCP', { userId });
        return true;
      } else {
        this.log('Failed to reset user context in Cipher MCP', { userId });
        return false;
      }
    } catch (error) {
      this.log('Failed to reset user context', { userId, error: error.message });
      return false;
    }
  }

  /**
   * Cipher MCP接続状態の確認
   */
  async checkCipherConnection() {
    try {
      if (!this.cipherClient.connected) {
        const reconnected = await this.cipherClient.connect();
        return reconnected;
      }
      return true;
    } catch (error) {
      this.log('Cipher MCP connection check failed', { error: error.message });
      return false;
    }
  }

  /**
   * Cipher MCPサーバーの統計情報を取得
   */
  async getCipherStatistics() {
    try {
      const stats = await this.cipherClient.makeRequest('cipher_get_statistics', {});
      
      this.log('Retrieved Cipher MCP statistics', { 
        totalMemories: stats?.totalMemories || 0,
        activeUsers: stats?.activeUsers || 0
      });
      
      return stats;
    } catch (error) {
      this.log('Failed to get Cipher MCP statistics', { error: error.message });
      return null;
    }
  }
}

module.exports = WebUICollaborationService;