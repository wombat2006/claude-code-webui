import { getErrorMessage } from '../utils/errorHandling';
/**
 * Language Utilities
 * Unified language detection, translation, and formatting functions
 */

import { SupportedLanguage, LanguageDetectionResult, LLMError } from '../types/llm';

export class LanguageUtils {
  private static instance: LanguageUtils;
  
  // Common Japanese patterns for detection
  private readonly japanesePatterns = [
    /[\u3040-\u309F]/, // Hiragana
    /[\u30A0-\u30FF]/, // Katakana
    /[\u4E00-\u9FAF]/, // Kanji
    /[\uFF65-\uFF9F]/, // Half-width Katakana
  ];

  // Business logic terms mapping (JP -> EN)
  private readonly businessTerms = new Map<string, string>([
    ['壁打ち', 'wall-bounce'],
    ['協調動作', 'collaboration'],
    ['司令塔', 'command-center'],
    ['検証', 'verification'],
    ['最低', 'minimum'],
    ['最大', 'maximum'],
    ['処理', 'processing'],
    ['結果', 'result'],
    ['品質', 'quality'],
    ['精度', 'accuracy'],
    ['効率', 'efficiency'],
    ['性能', 'performance'],
    ['安全', 'safety'],
    ['セキュリティ', 'security'],
    ['認証', 'authentication'],
    ['承認', 'authorization'],
    ['設定', 'configuration'],
    ['初期化', 'initialization'],
    ['終了', 'termination'],
    ['エラー', 'error'],
    ['警告', 'warning'],
    ['情報', 'information'],
    ['デバッグ', 'debug'],
    ['ログ', 'log'],
    ['メトリクス', 'metrics'],
    ['統計', 'statistics'],
    ['分析', 'analysis'],
    ['レポート', 'report']
  ]);

  // Error messages in both languages
  private readonly errorMessages = new Map<string, Record<SupportedLanguage, string>>([
    ['LANGUAGE_DETECTION_FAILED', {
      ja: '言語検出に失敗しました',
      en: 'Language detection failed'
    }],
    ['TRANSLATION_FAILED', {
      ja: '翻訳処理に失敗しました',
      en: 'Translation process failed'
    }],
    ['UNSUPPORTED_LANGUAGE', {
      ja: 'サポートされていない言語です',
      en: 'Unsupported language'
    }],
    ['INVALID_INPUT', {
      ja: '入力が無効です',
      en: 'Invalid input'
    }]
  ]);

  public static getInstance(): LanguageUtils {
    if (!LanguageUtils.instance) {
      LanguageUtils.instance = new LanguageUtils();
    }
    return LanguageUtils.instance;
  }

  /**
   * Detect language of input text
   */
  async detectLanguage(text: string): Promise<LanguageDetectionResult> {
    if (!text || text.trim().length === 0) {
      throw this.createError('INVALID_INPUT', 'Empty text provided');
    }

    try {
      // Statistical approach: check for Japanese characters
      const japaneseCount = this.countJapaneseCharacters(text);
      const totalChars = text.length;
      const japaneseRatio = japaneseCount / totalChars;

      // Business term detection
      const businessTermScore = this.calculateBusinessTermScore(text);

      // Combined scoring
      let language: SupportedLanguage;
      let confidence: number;

      if (japaneseRatio > 0.1 || businessTermScore > 0.3) {
        language = 'ja';
        confidence = Math.min(0.9, japaneseRatio + businessTermScore);
      } else {
        language = 'en';
        confidence = Math.min(0.9, 1 - japaneseRatio);
      }

      return {
        language,
        confidence,
        method: 'statistical'
      };

    } catch (error) {
      throw this.createError('LANGUAGE_DETECTION_FAILED', `Detection error: ${error}`);
    }
  }

  /**
   * Translate business terms while preserving technical accuracy
   */
  async translateBusinessTerms(text: string, from: SupportedLanguage, to: SupportedLanguage): Promise<string> {
    if (from === to) {
      return text;
    }

    try {
      let translatedText = text;

      if (from === 'ja' && to === 'en') {
        // Japanese to English business term translation
        for (const [japanese, english] of this.businessTerms.entries()) {
          const regex = new RegExp(japanese, 'g');
          translatedText = translatedText.replace(regex, english);
        }
      } else if (from === 'en' && to === 'ja') {
        // English to Japanese business term translation
        for (const [japanese, english] of this.businessTerms.entries()) {
          const regex = new RegExp(english, 'gi');
          translatedText = translatedText.replace(regex, japanese);
        }
      }

      return translatedText;

    } catch (error) {
      throw this.createError('TRANSLATION_FAILED', `Translation error: ${error}`);
    }
  }

  /**
   * Format LLM prompt with language-aware instructions
   */
  formatLLMPrompt(originalPrompt: string, targetLanguage: SupportedLanguage, context?: string): string {
    const languageInstructions = {
      ja: 'Please respond in Japanese (日本語で回答してください)',
      en: 'Please respond in English'
    };

    const contextPrefix = context ? `Context: ${context}\n\n` : '';
    const instruction = languageInstructions[targetLanguage];
    
    return `${contextPrefix}${instruction}\n\nQuery: ${originalPrompt}`;
  }

  /**
   * Format response with language-consistent structure
   */
  formatResponse(response: string, language: SupportedLanguage): string {
    // Add language-specific formatting
    const prefixes = {
      ja: '回答: ',
      en: 'Response: '
    };

    // Clean up mixed language artifacts
    let cleanedResponse = response;
    
    if (language === 'ja') {
      // Ensure Japanese punctuation
      cleanedResponse = cleanedResponse
        .replace(/\. /g, '。')
        .replace(/\? /g, '？')
        .replace(/! /g, '！');
    } else {
      // Ensure English punctuation
      cleanedResponse = cleanedResponse
        .replace(/。/g, '. ')
        .replace(/？/g, '? ')
        .replace(/！/g, '! ');
    }

    return cleanedResponse;
  }

  /**
   * Create localized error
   */
  createError(code: string, details?: string): LLMError {
    const messages = this.errorMessages.get(code) || {
      ja: '不明なエラーが発生しました',
      en: 'Unknown error occurred'
    };

    return {
      code,
      message: messages.en,
      localizedMessage: messages,
      severity: 'medium',
      retryable: false,
      ...(details && { providerError: details })
    };
  }

  /**
   * Get error message in specified language
   */
  getLocalizedErrorMessage(error: LLMError, language: SupportedLanguage): string {
    return error.localizedMessage[language] || getErrorMessage(error);
  }

  /**
   * Count Japanese characters in text
   */
  private countJapaneseCharacters(text: string): number {
    let count = 0;
    for (const pattern of this.japanesePatterns) {
      const matches = text.match(pattern);
      if (matches) {
        count += matches.length;
      }
    }
    return count;
  }

  /**
   * Calculate business term relevance score
   */
  private calculateBusinessTermScore(text: string): number {
    let score = 0;
    let termCount = 0;

    for (const [japanese, english] of this.businessTerms.entries()) {
      if (text.includes(japanese)) {
        score += 1;
        termCount++;
      }
      if (text.toLowerCase().includes(english.toLowerCase())) {
        score += 0.8; // Slightly lower weight for English terms
        termCount++;
      }
    }

    return termCount > 0 ? score / termCount : 0;
  }

  /**
   * Validate language code
   */
  isValidLanguage(language: string): language is SupportedLanguage {
    return language === 'ja' || language === 'en';
  }

  /**
   * Get default language based on content
   */
  getContentLanguage(content: string): SupportedLanguage {
    try {
      // Simple heuristic for immediate use
      const hasJapanese = this.japanesePatterns.some(pattern => pattern.test(content));
      return hasJapanese ? 'ja' : 'en';
    } catch {
      return 'en'; // Default to English on error
    }
  }

  /**
   * Log message with language context
   */
  logWithLanguage(level: 'info' | 'warn' | 'error', message: string, language?: SupportedLanguage) {
    const timestamp = new Date().toISOString();
    const langTag = language ? `[${language.toUpperCase()}]` : '';
    console[level](`[${timestamp}] ${langTag} ${message}`);
  }
}

// Export singleton instance
export const languageUtils = LanguageUtils.getInstance();