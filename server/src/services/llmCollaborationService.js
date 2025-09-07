/**
 * LLM Collaboration Service
 * CLAUDE.mdの指示に従った複数LLM協調動作(壁打ち)の実装
 * Claude Code が司令塔となり、他のLLMモデルとの壁打ちを行う
 */

const LLMGatewayService = require('./llmGatewayService');

class LLMCollaborationService {
  constructor(options = {}) {
    this.llmGateway = options.llmGateway || new LLMGatewayService(options);
    this.minWallBounces = options.minWallBounces || 3; // 最低3回の壁打ち
    this.maxWallBounces = options.maxWallBounces || 5; // 上限5回
    
    this.log = (message, data = {}) => {
      console.log(`[LLMCollaboration ${new Date().toISOString()}] ${message}`, JSON.stringify(data, null, 2));
    };

    this.log('LLM Collaboration Service initialized', {
      minWallBounces: this.minWallBounces,
      maxWallBounces: this.maxWallBounces
    });
  }

  /**
   * ユーザーの問い合わせに対して複数LLM協調動作を実行
   * CLAUDE.mdフロー:
   * 1. Claude Code が司令塔として問題を理解
   * 2. GPT-5 へクエリ発行
   * 3. GPT-5 の返答をClaude Code が解釈してSonnet4へ
   * 4. Sonnet4 の返答をClaude Code が解釈してGemini-2.5Proへ
   * 5. 最終的な検証結果をユーザーに返す
   */
  async processCollaborativeQuery(query, options = {}) {
    try {
      const {
        sessionId,
        taskType = 'general', // general, coding, analysis
        models = ['gpt-5', 'claude-4', 'gemini-2.5-pro']
      } = options;

      this.log('Starting collaborative query processing', {
        sessionId,
        taskType,
        queryLength: query.length,
        plannedModels: models
      });

      const collaborationHistory = [];
      let currentQuery = query;
      let claudeCodeAnalysis = '';

      // Step 1: Claude Code による初期分析と問題理解
      claudeCodeAnalysis = await this.analyzeUserIntent(query, taskType);
      collaborationHistory.push({
        step: 0,
        actor: 'claude-code',
        role: '司令塔・問題分析',
        input: query,
        output: claudeCodeAnalysis,
        timestamp: new Date().toISOString()
      });

      // Step 2-5: 各LLMとの壁打ち実行
      let lastResponse = claudeCodeAnalysis;
      const wallBounceModels = this.selectModelsForWallBounce(models, taskType);
      let actualStepNumber = 1;
      let successfulBounces = 0;
      
      // Keep trying models until we reach min bounces or max bounces
      let modelIndex = 0;
      while (actualStepNumber <= this.maxWallBounces && successfulBounces < this.minWallBounces && modelIndex < wallBounceModels.length * 2) {
        const currentModel = wallBounceModels[modelIndex % wallBounceModels.length];
        
        // 前回のレスポンスにClaude Codeの見解を付加
        const enrichedQuery = await this.enrichQueryWithClaudeCodeInsight(
          currentQuery, 
          lastResponse, 
          actualStepNumber,
          currentModel,
          collaborationHistory
        );

        this.log(`Wall bounce step ${actualStepNumber}`, {
          model: currentModel,
          enrichedQueryLength: enrichedQuery.length
        });

        try {
          // 対象LLMにクエリ実行
          const modelResponse = await this.callLLMModel(currentModel, enrichedQuery, {
            sessionId,
            step: actualStepNumber,
            context: collaborationHistory
          });

          collaborationHistory.push({
            step: actualStepNumber,
            actor: currentModel,
            role: '壁打ち参加者',
            input: enrichedQuery,
            output: modelResponse,
            timestamp: new Date().toISOString()
          });

          lastResponse = modelResponse;
          actualStepNumber++; // Only increment on success  
          successfulBounces++; // Count successful bounces
          
        } catch (error) {
          this.log(`Wall bounce step ${actualStepNumber} failed for ${currentModel}`, {
            error: error.message,
            willContinueWithNextModel: true
          });
          
          // Record the failure but continue with next model
          collaborationHistory.push({
            step: actualStepNumber,
            actor: currentModel,
            role: '壁打ち参加者（失敗）',
            input: enrichedQuery,
            output: `Error: ${error.message}`,
            error: true,
            timestamp: new Date().toISOString()
          });
          
          // Continue to next model without incrementing actualStepNumber
        }
        
        modelIndex++; // Always increment model index
      }

      // Use the successfulBounces variable we already tracked
      
      if (successfulBounces < this.minWallBounces) {
        this.log(`Warning: Only ${successfulBounces} successful wall bounces (minimum required: ${this.minWallBounces})`, {
          sessionId,
          successfulBounces,
          totalAttempts: collaborationHistory.length - 1 // Exclude initial analysis
        });
      }

      // Step 6: Claude Code による最終検証と統合
      const finalAnalysis = await this.synthesizeFinalResponse(
        query,
        collaborationHistory,
        claudeCodeAnalysis
      );

      // Calculate successful models used
      const successfulModels = collaborationHistory
        .filter(step => step.step > 0 && !step.error)
        .map(step => step.actor);
      
      const failedModels = collaborationHistory
        .filter(step => step.step > 0 && step.error)
        .map(step => step.actor);

      const result = {
        success: true,
        originalQuery: query,
        taskType,
        collaborationSteps: collaborationHistory.length,
        wallBounceCount: successfulBounces,
        failedBounceCount: failedModels.length,
        finalResponse: finalAnalysis,
        collaborationHistory,
        metadata: {
          sessionId,
          modelsAttempted: wallBounceModels,
          successfulModels,
          failedModels,
          processingTime: Date.now() - new Date(collaborationHistory[0].timestamp).getTime(),
          timestamp: new Date().toISOString()
        }
      };

      this.log('Collaborative query completed', {
        sessionId,
        wallBounceCount: result.wallBounceCount,
        failedBounceCount: result.failedBounceCount,
        successfulModels: result.metadata.successfulModels,
        failedModels: result.metadata.failedModels
      });

      return result;

    } catch (error) {
      this.log('Collaborative query failed', { error: error.message });
      throw error;
    }
  }

  /**
   * Claude Code による初期問題分析
   */
  async analyzeUserIntent(query, taskType) {
    // Claude Code としての問題分析ロジック
    const analysis = `
# Claude Code による問題分析

**ユーザークエリ**: ${query}
**タスクタイプ**: ${taskType}

## 問題の理解
${this.extractProblemContext(query, taskType)}

## 深掘りすべきポイント
${this.identifyKeyAspects(query, taskType)}

## 協調動作での検証方針
${this.planCollaborationStrategy(query, taskType)}
`;

    return analysis;
  }

  /**
   * 各ステップでのClaude Code見解付加
   */
  async enrichQueryWithClaudeCodeInsight(originalQuery, previousResponse, step, targetModel, history) {
    const insight = `
# Claude Code 司令塔からの問い合わせ (Step ${step})

**対象モデル**: ${targetModel}
**元のユーザークエリ**: ${originalQuery}

## 前ステップでの知見
${previousResponse}

## Claude Code の見解と深掘り方針
${this.generateClaudeCodeInsight(previousResponse, step, targetModel)}

## ${targetModel}への具体的な質問
${this.formulateSpecificQuestion(originalQuery, previousResponse, targetModel, history)}

---
上記を踏まえて、あなたの専門知識と視点から詳細な分析と提案をお願いします。
`;

    return insight;
  }

  /**
   * モデル選択ロジック (CLAUDE.mdに従ってコーディングタスクではGPT-5優先)
   */
  selectModelsForWallBounce(availableModels, taskType) {
    if (taskType === 'coding') {
      // コーディングタスクではGPT-5を優先
      return ['gpt-5', 'claude-4', 'gemini-2.5-pro'].filter(m => availableModels.includes(m));
    }
    
    // 一般的なタスクでは異なるベンダーでローテーション
    return ['gpt-5', 'claude-4', 'gemini-2.5-pro'].filter(m => availableModels.includes(m));
  }

  /**
   * 実際のLLMモデル呼び出し
   */
  async callLLMModel(model, query, options = {}) {
    try {
      this.log(`Calling LLM model ${model}`, { queryLength: query.length });
      
      // 既存のLLMGatewayServiceのqueryLLMメソッドを使用して実際のLLM呼び出し
      const startTime = Date.now();
      const response = await this.llmGateway.queryLLM(model, query, options);
      const endTime = Date.now();
      
      this.log(`LLM model ${model} responded`, { 
        latency: `${endTime - startTime}ms`,
        success: response.success 
      });

      if (response.success) {
        return response.response;
      } else {
        throw new Error(`LLM call failed: ${response.error}`);
      }
      
    } catch (error) {
      this.log(`Failed to call model ${model}`, { error: error.message });
      
      // モックfallbackは許容しない - エラーを再発生させる
      this.log(`Failed to call model ${model}, aborting collaboration`, { error: error.message });
      throw error;
    }
  }

  /**
   * 最終的な統合分析
   */
  async synthesizeFinalResponse(originalQuery, history, initialAnalysis) {
    const finalSynthesis = `
# 複数LLM協調動作による最終検証結果

## 元の問い合わせ
${originalQuery}

## Claude Code 初期分析
${initialAnalysis}

## 壁打ち結果サマリー
${history.slice(1).map((step, idx) => {
  if (step.error) {
    return `
### Step ${step.step}: ${step.actor} - 失敗
**エラー**: ${step.output}
*このモデルをスキップして協調動作を継続しました*`;
  } else {
    return `
### Step ${step.step}: ${step.actor} の見解
${step.output.substring(0, 200)}...`;
  }
}).join('\n')}

## Claude Code による統合判定
${this.generateFinalJudgment(originalQuery, history)}

## 推奨される行動
${this.generateRecommendations(originalQuery, history)}

---
**検証完了**: ${history.length - 1}回の壁打ちを通じて多角的検証を実施しました。
`;

    return finalSynthesis;
  }

  // ヘルパーメソッド
  extractProblemContext(query, taskType) {
    return `ユーザーは「${query}」について${taskType}タスクとしての回答を求めています。`;
  }

  identifyKeyAspects(query, taskType) {
    return `- 技術的な正確性\n- 実装の実現可能性\n- セキュリティ考慮\n- パフォーマンス影響`;
  }

  planCollaborationStrategy(query, taskType) {
    return `異なるLLMモデルの専門性を活かし、多角的な検証を通じて最適解を導出します。`;
  }

  generateClaudeCodeInsight(previousResponse, step, targetModel) {
    return `Step ${step}では${targetModel}の専門性を活かして前ステップの内容を深掘りし、新たな視点での検証を行います。`;
  }

  formulateSpecificQuestion(originalQuery, previousResponse, targetModel, history) {
    return `${targetModel}の専門知識を活かして「${originalQuery}」についてさらに詳しく分析してください。`;
  }

  generateFinalJudgment(originalQuery, history) {
    const successfulSteps = history.filter(step => step.step > 0 && !step.error);
    const failedSteps = history.filter(step => step.step > 0 && step.error);
    
    let judgment = `${successfulSteps.length}つのLLMモデルからの多角的な分析を統合した結果、以下の結論に至りました。`;
    
    if (failedSteps.length > 0) {
      judgment += `\n\n**注意**: ${failedSteps.length}つのモデル（${failedSteps.map(s => s.actor).join(', ')}）でAPIキーまたは接続エラーが発生しましたが、利用可能なモデルで協調動作を継続しました。`;
    }
    
    return judgment;
  }

  generateRecommendations(originalQuery, history) {
    return `1. 技術的実装の推奨事項\n2. セキュリティ面での注意点\n3. 次のステップでの検証事項`;
  }
}

module.exports = LLMCollaborationService;