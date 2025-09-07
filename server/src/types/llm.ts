/**
 * LLM Types and Interfaces
 * Unified type system for multilingual LLM interactions
 */

export type SupportedLanguage = 'ja' | 'en';
export type LLMProvider = 'openai' | 'anthropic' | 'google';
export type LLMModel = 
  | 'gpt-5' | 'gpt-5-mini' | 'gpt-5-nano' | 'o3-mini' | 'o4-mini'
  | 'claude-4' | 'claude-sonnet-4' | 'claude-opus-4.1' | 'claude-haiku-3.5'
  | 'gemini-2.5-pro' | 'gemini-2.5-flash' | 'gemini-2.0-flash';

export interface LLMRequest {
  /** Original query text */
  query: string;
  /** Target LLM model */
  model: LLMModel;
  /** Source language of the query */
  sourceLanguage: SupportedLanguage;
  /** Preferred response language */
  targetLanguage: SupportedLanguage;
  /** Session identifier for context management */
  sessionId?: string;
  /** Request options */
  options?: LLMRequestOptions;
}

export interface LLMRequestOptions {
  /** Response creativity (0.0-1.0) */
  temperature?: number;
  /** Maximum tokens in response */
  maxTokens?: number;
  /** Processing verbosity level */
  verbosity?: 'low' | 'medium' | 'high';
  /** Preserve conversation context */
  preserveContext?: boolean;
  /** Enable thinking mode for reasoning models */
  thinkingMode?: 'minimal' | 'low' | 'medium' | 'high' | 'max';
}

export interface LLMResponse {
  /** Generated response content */
  content: string;
  /** Response language detected/specified */
  language: SupportedLanguage;
  /** Model used for generation */
  model: LLMModel;
  /** Provider information */
  provider: LLMProvider;
  /** Token usage statistics */
  tokens: TokenUsage;
  /** Cost calculation */
  cost: number;
  /** Response latency in milliseconds */
  latency: number;
  /** Request success status */
  success: boolean;
  /** Error information if failed */
  error?: string;
  /** Additional metadata */
  metadata?: LLMResponseMetadata;
}

export interface TokenUsage {
  /** Input/prompt tokens */
  promptTokens: number;
  /** Output/completion tokens */
  completionTokens: number;
  /** Total tokens used */
  totalTokens: number;
  /** Cached tokens (if applicable) */
  cachedTokens?: number;
}

export interface LLMResponseMetadata {
  /** Request timestamp */
  requestTime: string;
  /** Response timestamp */
  responseTime: string;
  /** API version used */
  apiVersion?: string;
  /** Rate limit information */
  rateLimits?: RateLimitInfo;
  /** Quality metrics */
  quality?: QualityMetrics;
}

export interface RateLimitInfo {
  /** Requests per minute limit */
  requestsPerMinute: number;
  /** Remaining requests */
  remaining: number;
  /** Reset time */
  resetTime: string;
}

export interface QualityMetrics {
  /** Response relevance score (0-1) */
  relevance?: number;
  /** Language consistency score (0-1) */
  languageConsistency?: number;
  /** Content safety score (0-1) */
  safety?: number;
}

// Wall-bounce collaboration types
export interface CollaborationRequest {
  /** Original query for collaboration */
  query: string;
  /** Query language */
  language: SupportedLanguage;
  /** Session identifier */
  sessionId: string;
  /** Task type for collaboration */
  taskType?: string;
  /** Models to collaborate with */
  models?: LLMModel[];
  /** Minimum wall-bounce iterations */
  minWallBounces?: number;
  /** Maximum wall-bounce iterations */
  maxWallBounces?: number;
}

export interface CollaborationResponse {
  /** Final synthesized response */
  finalResponse: string;
  /** Response language */
  language: SupportedLanguage;
  /** Number of wall-bounces performed */
  wallBounceCount: number;
  /** Success status */
  success: boolean;
  /** Individual model responses */
  modelResponses: ModelCollaborationResponse[];
  /** Collaboration metadata */
  metadata: CollaborationMetadata;
}

export interface ModelCollaborationResponse {
  /** Model identifier */
  model: LLMModel;
  /** Model's response */
  response: string;
  /** Response language */
  language: SupportedLanguage;
  /** Processing latency */
  latency: number;
  /** Success status */
  success: boolean;
  /** Role in collaboration */
  role: string;
  /** Iteration number */
  iteration: number;
}

export interface CollaborationMetadata {
  /** Total processing time */
  processingTime: number;
  /** Models used */
  modelsUsed: LLMModel[];
  /** Total cost */
  totalCost: number;
  /** Total tokens used */
  totalTokens: number;
  /** Quality assessment */
  quality: 'low' | 'medium' | 'high' | 'excellent';
  /** Consensus level achieved */
  consensus: number; // 0-1 scale
}

// Pricing and cost calculation types
export interface PricingData {
  /** Last updated timestamp */
  updated_at: string;
  /** Currency unit */
  currency: string;
  /** Pricing unit */
  unit: string;
  /** Provider-specific pricing */
  providers: Record<LLMProvider, ProviderPricing>;
}

export interface ProviderPricing {
  [modelName: string]: ModelPricing;
}

export interface ModelPricing {
  /** Input cost per 1K tokens */
  input_per_1k: number;
  /** Output cost per 1K tokens */
  output_per_1k: number;
  /** Cached input cost per 1K tokens */
  cached_input_per_1k?: number;
  /** Cache write cost per 1K tokens */
  cache_write_per_1k?: number;
  /** Pricing source URL */
  source: string;
  /** Additional notes */
  notes?: string;
}

// Error handling types
export interface LLMError {
  /** Error code */
  code: string;
  /** Error message */
  message: string;
  /** Message in both languages */
  localizedMessage: Record<SupportedLanguage, string>;
  /** Error severity */
  severity: 'low' | 'medium' | 'high' | 'critical';
  /** Provider-specific error details */
  providerError?: any;
  /** Retry suggestion */
  retryable: boolean;
}

// Configuration types
export interface LLMConfiguration {
  /** Default language for interactions */
  defaultLanguage: SupportedLanguage;
  /** Available models by provider */
  availableModels: Record<LLMProvider, LLMModel[]>;
  /** Default request options */
  defaultOptions: LLMRequestOptions;
  /** Wall-bounce configuration */
  collaboration: {
    minWallBounces: number;
    maxWallBounces: number;
    defaultModels: LLMModel[];
  };
  /** Rate limiting configuration */
  rateLimits: Record<LLMProvider, RateLimitConfig>;
}

export interface RateLimitConfig {
  /** Requests per minute */
  requestsPerMinute: number;
  /** Burst allowance */
  burstSize: number;
  /** Backoff strategy */
  backoffStrategy: 'exponential' | 'linear' | 'fixed';
}

// Language detection and processing
export interface LanguageDetectionResult {
  /** Detected language */
  language: SupportedLanguage;
  /** Confidence score (0-1) */
  confidence: number;
  /** Detection method used */
  method: 'pattern' | 'statistical' | 'api';
}

// Utility types
export type LLMLogger = {
  info(message: string, data?: any): void;
  warn(message: string, data?: any): void;
  error(message: string, data?: any): void;
  debug(message: string, data?: any): void;
};

export type LanguageUtils = {
  detectLanguage(text: string): Promise<LanguageDetectionResult>;
  translatePrompt(text: string, from: SupportedLanguage, to: SupportedLanguage): Promise<string>;
  formatResponse(response: string, language: SupportedLanguage): string;
};