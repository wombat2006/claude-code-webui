/**
 * LLM Gateway Service - TypeScript Migration
 * Unified multilingual LLM interaction service with type safety
 * Migrated from llmGatewayService.js with enhanced language support
 */

import fs from 'fs';
import path from 'path';
import { 
  LLMRequest, 
  LLMResponse, 
  LLMModel, 
  LLMProvider, 
  SupportedLanguage,
  TokenUsage,
  PricingData,
  LLMError,
  LLMConfiguration,
  LLMLogger
} from '../types/llm';
import { languageUtils } from '../utils/languageUtils';

export class LLMGatewayService {
  private readonly maxContextLength: number;
  private readonly defaultMaxReferences: number;
  private readonly ragStorage: any; // TODO: Type this properly
  private readonly snapshotRetriever: any; // TODO: Type this properly
  private pricingData: PricingData | null = null;
  private readonly logger: LLMLogger;
  private readonly config: LLMConfiguration;

  constructor(options: {
    snapshotDir?: string;
    cacheDir?: string;
    ragStorageDir?: string;
    maxCacheSize?: number;
    maxContextLength?: number;
    defaultMaxReferences?: number;
    logger?: LLMLogger;
  } = {}) {
    this.maxContextLength = options.maxContextLength || 8000;
    this.defaultMaxReferences = options.defaultMaxReferences || 5;
    
    // Initialize logger
    this.logger = options.logger || {
      info: (msg, data) => console.log(`[LLMGateway] ${msg}`, data || ''),
      warn: (msg, data) => console.warn(`[LLMGateway] ${msg}`, data || ''),
      error: (msg, data) => console.error(`[LLMGateway] ${msg}`, data || ''),
      debug: (msg, data) => console.debug(`[LLMGateway] ${msg}`, data || '')
    };

    // Initialize configuration
    this.config = this.initializeConfiguration();

    // Initialize storage services (preserving existing functionality)
    this.initializeStorageServices(options);

    this.logger.info('LLM Gateway Service initialized', {
      maxContextLength: this.maxContextLength,
      defaultMaxReferences: this.defaultMaxReferences,
      defaultLanguage: this.config.defaultLanguage
    });
  }

  /**
   * Unified LLM query method with language awareness
   */
  async queryLLM(
    model: LLMModel | string, 
    query: string, 
    options: {
      sessionId?: string;
      sourceLanguage?: SupportedLanguage;
      targetLanguage?: SupportedLanguage;
      temperature?: number;
      maxTokens?: number;
      verbosity?: 'low' | 'medium' | 'high';
      preserveContext?: boolean;
    } = {}
  ): Promise<LLMResponse> {
    const startTime = Date.now();

    try {
      // Language detection and processing
      const detectedLanguage = await languageUtils.detectLanguage(query);
      const sourceLanguage = options.sourceLanguage || detectedLanguage.language;
      const targetLanguage = options.targetLanguage || sourceLanguage;

      this.logger.info('Processing LLM query', {
        model,
        sourceLanguage,
        targetLanguage,
        queryLength: query.length,
        sessionId: options.sessionId
      });

      // Format prompt with language instructions
      const formattedPrompt = languageUtils.formatLLMPrompt(query, targetLanguage);

      // Determine provider and call appropriate method
      const provider = this.getProviderFromModel(model as LLMModel);
      let response: LLMResponse;

      switch (provider) {
        case 'anthropic':
          response = await this.callClaudeAPI(model as LLMModel, formattedPrompt, options);
          break;
        case 'openai':
          response = await this.callOpenAIAPI(model as LLMModel, formattedPrompt, options);
          break;
        case 'google':
          response = await this.callGoogleAPI(model as LLMModel, formattedPrompt, options);
          break;
        default:
          throw this.createError('UNSUPPORTED_PROVIDER', `Unknown provider for model: ${model}`);
      }

      // Format response with language consistency
      const formattedContent = languageUtils.formatResponse(response.content, targetLanguage);
      
      const finalResponse: LLMResponse = {
        ...response,
        content: formattedContent,
        language: targetLanguage,
        latency: Date.now() - startTime,
        metadata: {
          ...response.metadata,
          requestTime: new Date(startTime).toISOString(),
          responseTime: new Date().toISOString()
        }
      };

      this.logger.info('LLM query completed', {
        model: finalResponse.model,
        provider: finalResponse.provider,
        tokens: finalResponse.tokens.totalTokens,
        cost: finalResponse.cost,
        latency: finalResponse.latency,
        success: finalResponse.success
      });

      return finalResponse;

    } catch (error) {
      this.logger.error('LLM query failed', {
        model,
        error: error instanceof Error ? error.message : String(error),
        latency: Date.now() - startTime
      });

      throw this.isLLMError(error) ? error : this.createError(
        'LLM_QUERY_FAILED', 
        `Query failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Claude API integration with language support
   */
  private async callClaudeAPI(
    model: LLMModel, 
    prompt: string, 
    options: any = {}
  ): Promise<LLMResponse> {
    try {
      const Anthropic = require('@anthropic-ai/sdk');
      const anthropic = new Anthropic({
        apiKey: process.env.ANTHROPIC_API_KEY
      });

      const response = await anthropic.messages.create({
        model: this.mapModelToAPIName(model, 'anthropic'),
        max_tokens: options.maxTokens || 2048,
        temperature: options.temperature || 0.7,
        messages: [{
          role: 'user',
          content: prompt
        }]
      });

      const promptTokens = response.usage.input_tokens;
      const completionTokens = response.usage.output_tokens;
      const cost = this.calculateAccurateCost(model, promptTokens, completionTokens);

      return {
        content: response.content[0].text,
        language: languageUtils.getContentLanguage(response.content[0].text),
        model,
        provider: 'anthropic',
        tokens: {
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens
        },
        cost,
        latency: 0, // Will be set by caller
        success: true
      };

    } catch (error) {
      this.logger.error('Claude API error', { model, error });
      throw this.createError('CLAUDE_API_ERROR', `Claude API failed: ${error}`);
    }
  }

  /**
   * OpenAI API integration with language support
   */
  private async callOpenAIAPI(
    model: LLMModel, 
    prompt: string, 
    options: any = {}
  ): Promise<LLMResponse> {
    try {
      const OpenAI = require('openai');
      const openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY
      });

      const response = await openai.chat.completions.create({
        model: this.mapModelToAPIName(model, 'openai'),
        messages: [{
          role: 'user',
          content: prompt
        }],
        temperature: options.temperature || 0.7,
        max_tokens: options.maxTokens || 2048
      });

      const promptTokens = response.usage?.prompt_tokens || 0;
      const completionTokens = response.usage?.completion_tokens || 0;
      const cost = this.calculateAccurateCost(model, promptTokens, completionTokens);

      return {
        content: response.choices[0].message?.content || '',
        language: languageUtils.getContentLanguage(response.choices[0].message?.content || ''),
        model,
        provider: 'openai',
        tokens: {
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens
        },
        cost,
        latency: 0,
        success: true
      };

    } catch (error) {
      this.logger.error('OpenAI API error', { model, error });
      throw this.createError('OPENAI_API_ERROR', `OpenAI API failed: ${error}`);
    }
  }

  /**
   * Google API integration with language support
   */
  private async callGoogleAPI(
    model: LLMModel, 
    prompt: string, 
    options: any = {}
  ): Promise<LLMResponse> {
    try {
      const { GoogleGenerativeAI } = require('@google/generative-ai');
      const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);

      const geminiModel = genAI.getGenerativeModel({ 
        model: this.mapModelToAPIName(model, 'google')
      });

      const result = await geminiModel.generateContent(prompt);
      const response = await result.response;
      const text = response.text();

      // Token estimation for Google models
      const promptTokens = Math.ceil(prompt.length / 4);
      const completionTokens = Math.ceil(text.length / 4);
      const cost = this.calculateAccurateCost(model, promptTokens, completionTokens);

      return {
        content: text,
        language: languageUtils.getContentLanguage(text),
        model,
        provider: 'google',
        tokens: {
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens
        },
        cost,
        latency: 0,
        success: true
      };

    } catch (error) {
      this.logger.error('Google API error', { model, error });
      throw this.createError('GOOGLE_API_ERROR', `Google API failed: ${error}`);
    }
  }

  /**
   * Load and cache pricing data
   */
  private loadPricingData(): PricingData | null {
    if (!this.pricingData) {
      try {
        const pricingPath = path.join(__dirname, '../../../docs/pricing/MODEL_PRICING_WITH_1K.json');
        const data = fs.readFileSync(pricingPath, 'utf8');
        this.pricingData = JSON.parse(data);
        this.logger.info('Pricing data loaded successfully');
      } catch (error) {
        this.logger.error('Failed to load pricing data', { error });
        this.pricingData = null;
      }
    }
    return this.pricingData;
  }

  /**
   * Calculate accurate cost using official pricing table
   */
  private calculateAccurateCost(model: LLMModel, promptTokens: number, completionTokens: number): number {
    const pricingData = this.loadPricingData();
    
    if (!pricingData) {
      return this.calculateFallbackCost(model, promptTokens, completionTokens);
    }

    const provider = this.getProviderFromModel(model);
    const modelKey = this.getModelPricingKey(model);
    const modelPricing = pricingData.providers[provider]?.[modelKey];

    if (!modelPricing?.input_per_1k || !modelPricing?.output_per_1k) {
      return this.calculateFallbackCost(model, promptTokens, completionTokens);
    }

    const inputCost = (promptTokens / 1000) * modelPricing.input_per_1k;
    const outputCost = (completionTokens / 1000) * modelPricing.output_per_1k;
    
    return inputCost + outputCost;
  }

  /**
   * Fallback cost calculation
   */
  private calculateFallbackCost(model: LLMModel, promptTokens: number, completionTokens: number): number {
    const rates = this.getFallbackRates(model);
    return (promptTokens / 1000) * rates.input + (completionTokens / 1000) * rates.output;
  }

  /**
   * Helper methods for provider and model mapping
   */
  private getProviderFromModel(model: LLMModel): LLMProvider {
    if (model.includes('gpt') || model.includes('o3') || model.includes('o4')) return 'openai';
    if (model.includes('claude')) return 'anthropic';
    if (model.includes('gemini')) return 'google';
    throw this.createError('UNKNOWN_PROVIDER', `Cannot determine provider for model: ${model}`);
  }

  private mapModelToAPIName(model: LLMModel, provider: LLMProvider): string {
    // Model name mapping logic
    const mappings = {
      openai: {
        'gpt-5': 'gpt-5',
        'gpt-5-mini': 'gpt-5-mini',
        'o3-mini': 'o3-mini',
        'o4-mini': 'o4-mini'
      },
      anthropic: {
        'claude-4': 'claude-3-5-sonnet-20241022',
        'claude-sonnet-4': 'claude-3-5-sonnet-20241022'
      },
      google: {
        'gemini-2.5-pro': 'gemini-1.5-pro',
        'gemini-2.5-flash': 'gemini-1.5-flash'
      }
    };

    return mappings[provider]?.[model] || model;
  }

  private getModelPricingKey(model: LLMModel): string {
    const keyMappings: Record<string, string> = {
      'claude-4': 'claude-sonnet-4',
      'claude-sonnet-4': 'claude-sonnet-4',
      'gpt-5': 'gpt-5',
      'gpt-5-mini': 'gpt-5-mini',
      'gemini-2.5-pro': 'gemini-2.5-pro'
    };
    
    return keyMappings[model] || model;
  }

  private getFallbackRates(model: LLMModel): { input: number; output: number } {
    const fallbackRates: Record<string, { input: number; output: number }> = {
      'claude-4': { input: 0.003, output: 0.015 },
      'gpt-5': { input: 0.00125, output: 0.01 },
      'gemini-2.5-pro': { input: 0.00125, output: 0.01 }
    };

    return fallbackRates[model] || { input: 0.003, output: 0.015 };
  }

  /**
   * Initialize configuration
   */
  private initializeConfiguration(): LLMConfiguration {
    return {
      defaultLanguage: 'ja', // Based on CLAUDE.md requirements
      availableModels: {
        openai: ['gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'o3-mini', 'o4-mini'],
        anthropic: ['claude-4', 'claude-sonnet-4', 'claude-opus-4.1', 'claude-haiku-3.5'],
        google: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash']
      },
      defaultOptions: {
        temperature: 0.7,
        maxTokens: 2048,
        verbosity: 'medium',
        preserveContext: true
      },
      collaboration: {
        minWallBounces: 3,
        maxWallBounces: 5,
        defaultModels: ['gpt-5', 'claude-4', 'gemini-2.5-pro']
      },
      rateLimits: {
        openai: { requestsPerMinute: 60, burstSize: 10, backoffStrategy: 'exponential' },
        anthropic: { requestsPerMinute: 60, burstSize: 10, backoffStrategy: 'exponential' },
        google: { requestsPerMinute: 60, burstSize: 10, backoffStrategy: 'exponential' }
      }
    };
  }

  /**
   * Initialize storage services (preserving existing functionality)
   */
  private initializeStorageServices(options: any): void {
    // TODO: Properly type these services during migration
    const SessionSnapshotRetriever = require('./sessionSnapshotRetriever');
    const RagStorageService = require('./ragStorageService');

    (this as any).ragStorage = new RagStorageService({
      storageDir: options.ragStorageDir || '/tmp/claude-rag-storage',
      cacheLimit: options.maxCacheSize || 20
    });

    // Initialize snapshot retriever
    (this as any).snapshotRetriever = new SessionSnapshotRetriever({
      snapshotDir: options.snapshotDir || '/tmp/claude-snapshots',
      cacheDir: options.cacheDir || '/tmp/claude-snapshot-index',
      maxCacheSize: options.maxCacheSize || 50
    });
  }

  /**
   * Create typed error
   */
  private createError(code: string, message: string): LLMError {
    return languageUtils.createError(code, message);
  }

  /**
   * Type guard for LLMError
   */
  private isLLMError(error: any): error is LLMError {
    return error && typeof error === 'object' && 'code' in error && 'localizedMessage' in error;
  }

  /**
   * Get service statistics
   */
  getStats(): {
    gateway: any;
    retriever: any;
    ragStorage: any;
  } {
    return {
      gateway: {
        maxContextLength: this.maxContextLength,
        defaultMaxReferences: this.defaultMaxReferences,
        defaultLanguage: this.config.defaultLanguage,
        timestamp: Date.now()
      },
      retriever: (this as any).snapshotRetriever?.getStats?.() || {},
      ragStorage: this.ragStorage?.getStats?.() || {}
    };
  }
}