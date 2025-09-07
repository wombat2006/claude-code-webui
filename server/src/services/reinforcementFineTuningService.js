/**
 * Reinforcement Fine-Tuning Service for o4-mini-2025-04-16
 * Implements expert grading and chain-of-thought reinforcement
 * Based on OpenAI Model Optimization guidelines
 */

class ReinforcementFineTuningService {
  constructor(options = {}) {
    this.apiKey = process.env.OPENAI_API_KEY;
    this.baseModel = 'o4-mini-2025-04-16';
    this.expertGraders = new Map();
    this.trainingJobs = new Map();
    
    this.log = (message, data = {}) => {
      console.log(`[RFT ${new Date().toISOString()}] ${message}`, JSON.stringify(data, null, 2));
    };

    this.log('Reinforcement Fine-Tuning Service initialized', {
      baseModel: this.baseModel
    });
  }

  /**
   * Create expert grader for specific domain
   */
  createExpertGrader(domain, gradingCriteria) {
    const grader = {
      domain,
      criteria: gradingCriteria,
      scoreRange: { min: 0, max: 100 },
      weightedCriteria: gradingCriteria.map(criterion => ({
        ...criterion,
        weight: criterion.weight || 1.0
      })),
      created: new Date().toISOString()
    };

    this.expertGraders.set(domain, grader);
    this.log('Expert grader created', { domain, criteria: gradingCriteria });
    
    return grader;
  }

  /**
   * Grade model response using expert grader
   */
  async gradeResponse(domain, prompt, response, chainOfThought) {
    const grader = this.expertGraders.get(domain);
    if (!grader) {
      throw new Error(`No expert grader found for domain: ${domain}`);
    }

    const scores = [];
    let totalScore = 0;
    let totalWeight = 0;

    // Score each criterion
    for (const criterion of grader.weightedCriteria) {
      const score = await this.scoreCriterion(criterion, prompt, response, chainOfThought);
      scores.push({
        criterion: criterion.name,
        score,
        weight: criterion.weight,
        weightedScore: score * criterion.weight
      });
      totalScore += score * criterion.weight;
      totalWeight += criterion.weight;
    }

    const finalScore = totalScore / totalWeight;

    const grading = {
      domain,
      prompt,
      response,
      chainOfThought,
      finalScore,
      detailedScores: scores,
      gradedAt: new Date().toISOString(),
      graderVersion: grader.created
    };

    this.log('Response graded', {
      domain,
      finalScore,
      criteriaCount: scores.length
    });

    return grading;
  }

  /**
   * Score individual criterion
   */
  async scoreCriterion(criterion, prompt, response, chainOfThought) {
    switch (criterion.type) {
      case 'accuracy':
        return this.scoreAccuracy(criterion, prompt, response);
      case 'reasoning_quality':
        return this.scoreReasoningQuality(criterion, chainOfThought);
      case 'completeness':
        return this.scoreCompleteness(criterion, prompt, response);
      case 'safety':
        return this.scoreSafety(criterion, response);
      case 'domain_expertise':
        return this.scoreDomainExpertise(criterion, prompt, response);
      default:
        this.log('Unknown criterion type', { type: criterion.type });
        return 50; // Neutral score
    }
  }

  /**
   * Score accuracy against ground truth
   */
  scoreAccuracy(criterion, prompt, response) {
    if (!criterion.groundTruth) {
      return 50;
    }

    const similarity = this.calculateSimilarity(response, criterion.groundTruth);
    return Math.min(100, similarity * 100);
  }

  /**
   * Score reasoning quality based on chain-of-thought
   */
  scoreReasoningQuality(criterion, chainOfThought) {
    if (!chainOfThought || chainOfThought.length === 0) {
      return 10; // Very low score for missing reasoning
    }

    let score = 50; // Base score

    // Check for logical flow
    if (this.hasLogicalFlow(chainOfThought)) {
      score += 20;
    }

    // Check for evidence usage
    if (this.usesEvidence(chainOfThought)) {
      score += 15;
    }

    // Check for consideration of alternatives
    if (this.considersAlternatives(chainOfThought)) {
      score += 15;
    }

    return Math.min(100, score);
  }

  /**
   * Score response completeness
   */
  scoreCompleteness(criterion, prompt, response) {
    const requiredElements = criterion.requiredElements || [];
    let foundElements = 0;

    for (const element of requiredElements) {
      if (response.toLowerCase().includes(element.toLowerCase())) {
        foundElements++;
      }
    }

    return requiredElements.length > 0 
      ? (foundElements / requiredElements.length) * 100
      : 75; // Default score if no specific requirements
  }

  /**
   * Score safety of response
   */
  scoreSafety(criterion, response) {
    const safetyFlags = [
      { pattern: /harmful|dangerous|illegal/i, penalty: 50 },
      { pattern: /biased|discriminatory/i, penalty: 30 },
      { pattern: /inappropriate|offensive/i, penalty: 40 }
    ];

    let score = 100;
    for (const flag of safetyFlags) {
      if (flag.pattern.test(response)) {
        score -= flag.penalty;
      }
    }

    return Math.max(0, score);
  }

  /**
   * Score domain expertise
   */
  scoreDomainExpertise(criterion, prompt, response) {
    const domainKeywords = criterion.domainKeywords || [];
    const technicalTerms = criterion.technicalTerms || [];
    
    let score = 40; // Base score

    // Check for domain-specific vocabulary
    const domainWordCount = domainKeywords.filter(keyword => 
      response.toLowerCase().includes(keyword.toLowerCase())
    ).length;
    
    score += Math.min(30, (domainWordCount / domainKeywords.length) * 30);

    // Check for technical accuracy
    const technicalTermCount = technicalTerms.filter(term =>
      response.toLowerCase().includes(term.toLowerCase())
    ).length;
    
    score += Math.min(30, (technicalTermCount / technicalTerms.length) * 30);

    return Math.min(100, score);
  }

  /**
   * Helper methods for reasoning quality assessment
   */
  hasLogicalFlow(chainOfThought) {
    const flowIndicators = ['because', 'therefore', 'thus', 'consequently', 'since', 'as a result'];
    const text = chainOfThought.join(' ').toLowerCase();
    return flowIndicators.some(indicator => text.includes(indicator));
  }

  usesEvidence(chainOfThought) {
    const evidenceIndicators = ['according to', 'evidence shows', 'data indicates', 'studies suggest'];
    const text = chainOfThought.join(' ').toLowerCase();
    return evidenceIndicators.some(indicator => text.includes(indicator));
  }

  considersAlternatives(chainOfThought) {
    const alternativeIndicators = ['however', 'alternatively', 'on the other hand', 'another approach'];
    const text = chainOfThought.join(' ').toLowerCase();
    return alternativeIndicators.some(indicator => text.includes(indicator));
  }

  /**
   * Calculate text similarity (simple implementation)
   */
  calculateSimilarity(text1, text2) {
    const words1 = text1.toLowerCase().split(/\W+/);
    const words2 = text2.toLowerCase().split(/\W+/);
    const intersection = words1.filter(word => words2.includes(word));
    const union = [...new Set([...words1, ...words2])];
    return intersection.length / union.length;
  }

  /**
   * Create reinforcement fine-tuning dataset
   */
  async createTrainingDataset(gradings, options = {}) {
    const trainingExamples = [];

    for (const grading of gradings) {
      // Only include high-quality examples (score > threshold)
      const threshold = options.scoreThreshold || 70;
      
      if (grading.finalScore >= threshold) {
        const example = {
          messages: [
            {
              role: 'user',
              content: grading.prompt
            },
            {
              role: 'assistant',
              content: grading.response,
              reasoning: grading.chainOfThought
            }
          ],
          score: grading.finalScore,
          domain: grading.domain,
          grading_details: grading.detailedScores
        };

        trainingExamples.push(example);
      }
    }

    this.log('Training dataset created', {
      totalGradings: gradings.length,
      selectedExamples: trainingExamples.length,
      threshold
    });

    return trainingExamples;
  }

  /**
   * Start reinforcement fine-tuning job
   */
  async startFineTuningJob(dataset, options = {}) {
    const { OpenAI } = await import('openai');
    const openai = new OpenAI({ apiKey: this.apiKey });

    try {
      // Upload training dataset
      const fileData = dataset.map(example => JSON.stringify(example)).join('\n');
      const file = await openai.files.create({
        file: new Blob([fileData], { type: 'application/jsonl' }),
        purpose: 'fine-tune'
      });

      this.log('Training file uploaded', { fileId: file.id });

      // Create fine-tuning job with RFT parameters
      const fineTuningJob = await openai.fineTuning.jobs.create({
        model: this.baseModel,
        training_file: file.id,
        method: 'reinforcement', // RFT method
        hyperparameters: {
          learning_rate: options.learningRate || 1e-5,
          batch_size: options.batchSize || 16,
          n_epochs: options.epochs || 3,
          reward_model: options.rewardModel || 'default'
        },
        suffix: options.suffix || 'rft-enhanced'
      });

      this.trainingJobs.set(fineTuningJob.id, {
        job: fineTuningJob,
        dataset: dataset.length,
        started: new Date().toISOString(),
        status: 'running'
      });

      this.log('Fine-tuning job started', {
        jobId: fineTuningJob.id,
        model: this.baseModel,
        trainingExamples: dataset.length
      });

      return fineTuningJob;

    } catch (error) {
      this.log('Failed to start fine-tuning job', { error: error.message });
      throw error;
    }
  }

  /**
   * Check fine-tuning job status
   */
  async checkJobStatus(jobId) {
    const { OpenAI } = await import('openai');
    const openai = new OpenAI({ apiKey: this.apiKey });

    try {
      const job = await openai.fineTuning.jobs.retrieve(jobId);
      
      if (this.trainingJobs.has(jobId)) {
        this.trainingJobs.get(jobId).status = job.status;
      }

      this.log('Job status checked', {
        jobId,
        status: job.status,
        fineTunedModel: job.fine_tuned_model
      });

      return job;
    } catch (error) {
      this.log('Failed to check job status', { jobId, error: error.message });
      throw error;
    }
  }

  /**
   * Get expert graders for domain
   */
  getGrader(domain) {
    return this.expertGraders.get(domain);
  }

  /**
   * List all training jobs
   */
  getTrainingJobs() {
    return Array.from(this.trainingJobs.entries()).map(([id, data]) => ({
      id,
      ...data
    }));
  }

  /**
   * Get service statistics
   */
  getStats() {
    return {
      expertGraders: this.expertGraders.size,
      activeJobs: Array.from(this.trainingJobs.values()).filter(job => 
        job.status === 'running' || job.status === 'pending'
      ).length,
      completedJobs: Array.from(this.trainingJobs.values()).filter(job => 
        job.status === 'succeeded'
      ).length,
      baseModel: this.baseModel
    };
  }
}

module.exports = ReinforcementFineTuningService;