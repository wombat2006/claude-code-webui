#!/usr/bin/env node

/**
 * Direct test of o4-mini-2025-04-16 model availability and RFT functionality
 */

const LLMGatewayService = require('./server/src/services/llmGatewayService');

async function testO4MiniDirect() {
    console.log('🧪 Testing o4-mini-2025-04-16 model availability...');
    
    const gateway = new LLMGatewayService();
    
    // Test 1: Basic o4-mini call
    console.log('\n1. Testing basic o4-mini call...');
    try {
        const result = await gateway.callOpenAIAPI('o4-mini', 'Hello, please confirm this is o4-mini-2025-04-16 working correctly.', {
            verbosity: 'standard',
            effort: 'medium'
        });
        
        console.log('✅ Basic o4-mini test successful');
        console.log('Response:', result.content.substring(0, 200) + '...');
        console.log('Model used:', result.model);
        console.log('API Type:', result.apiType);
        console.log('Tokens:', result.tokens);
        
    } catch (error) {
        console.log('❌ Basic o4-mini test failed:', error.message);
    }
    
    // Test 2: Test with fine-tuning parameters
    console.log('\n2. Testing o4-mini with fine-tuning parameters...');
    try {
        const result = await gateway.callOpenAIAPI('o4-mini-2025-04-16', 'Test RFT capabilities', {
            verbosity: 'detailed',
            effort: 'high',
            fineTuneId: 'test-rft-model-id',
            expertGrading: true,
            learning_rate: 1e-5,
            batch_size: 16,
            reward_model: 'default'
        });
        
        console.log('✅ RFT parameter test successful');
        console.log('Response:', result.content.substring(0, 200) + '...');
        console.log('Model used:', result.model);
        console.log('Parameters:', result.parameters);
        
    } catch (error) {
        console.log('❌ RFT parameter test failed:', error.message);
    }
    
    // Test 3: Check model availability through OpenAI API
    console.log('\n3. Testing model availability through OpenAI API...');
    try {
        const { OpenAI } = await import('openai');
        const openai = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY
        });
        
        // List available models
        const models = await openai.models.list();
        const o4Models = models.data.filter(model => model.id.includes('o4'));
        
        console.log('Available o4 models:', o4Models.map(m => m.id));
        
        const hasO4Mini2025 = o4Models.some(m => m.id === 'o4-mini-2025-04-16');
        console.log('o4-mini-2025-04-16 available:', hasO4Mini2025);
        
    } catch (error) {
        console.log('❌ Model availability check failed:', error.message);
    }
    
    // Test 4: Test Responses API compatibility
    console.log('\n4. Testing Responses API with o4-mini...');
    try {
        const { OpenAI } = await import('openai');
        const openai = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY
        });
        
        const response = await openai.responses.create({
            model: 'o4-mini-2025-04-16',
            input: [
                { role: 'user', content: 'Test the latest o4-mini model with Responses API' }
            ],
            text: {
                verbosity: 'standard'
            },
            reasoning: {
                effort: 'medium'  
            },
            temperature: 1,
            store: false
        });
        
        console.log('✅ Responses API test successful');
        console.log('Output type:', response.output?.[0]?.type || 'unknown');
        console.log('Content length:', response.output_text?.length || 0);
        
    } catch (error) {
        console.log('❌ Responses API test failed:', error.message);
        console.log('Error details:', error.response?.data || error.status);
    }
}

// Execute test
if (require.main === module) {
    testO4MiniDirect()
        .then(() => {
            console.log('\n🏁 o4-mini testing completed');
        })
        .catch((error) => {
            console.error('\n💥 Test failed:', error.message);
            process.exit(1);
        });
}

module.exports = { testO4MiniDirect };