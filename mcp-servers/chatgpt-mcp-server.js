#!/usr/bin/env node
import * as dotenv from 'dotenv';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import OpenAI from 'openai';
import { GoogleGenAI } from '@google/genai';

// Load environment variables
dotenv.config();

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || '',
});

// Initialize Google AI client
let genAI = null;
if (process.env.GOOGLE_API_KEY) {
  genAI = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });
} else {
  console.error('Warning: GOOGLE_API_KEY not found. Gemini features will be disabled.');
}

// Create MCP server
const server = new Server(
  {
    name: 'mcp-openai-gemini',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'chat_with_gpt',
        description: 'Chat with OpenAI GPT models (e.g., gpt-5-2025-08-07, GPT-5, GPT-5-mini, GPT-4o, GPT-4, etc.)',
        inputSchema: {
          type: 'object',
          properties: {
            model: {
              type: 'string',
              description: 'Model to use (e.g., gpt-5-2025-08-07, gpt-5, gpt-5-mini, gpt-4o, gpt-4, etc.)',
              default: process.env.OPENAI_MODEL || 'gpt-4',
            },
            messages: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  role: {
                    type: 'string',
                    enum: ['system', 'user', 'assistant'],
                  },
                  content: {
                    type: 'string',
                  },
                },
                required: ['role', 'content'],
              },
              description: 'Array of messages for the conversation',
            },
            temperature: {
              type: 'number',
              description: 'Sampling temperature (0-2)',
              default: 1.0,
            },
            max_tokens: {
              type: 'number',
              description: 'Maximum tokens in response',
              default: 2500,
            },
          },
          required: ['messages'],
        },
      },
      {
        name: 'chat_with_gemini',
        description: 'Chat with Google Gemini models (e.g., gemini-2.0-flash-exp, gemini-1.5-pro, gemini-1.5-flash, etc.)',
        inputSchema: {
          type: 'object',
          properties: {
            model: {
              type: 'string',
              description: 'Gemini model to use (e.g., gemini-2.0-flash-exp, gemini-1.5-pro, gemini-1.5-flash)',
              default: process.env.GEMINI_MODEL || 'gemini-2.0-flash-001',
            },
            messages: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  role: {
                    type: 'string',
                    enum: ['user', 'model'],
                  },
                  content: {
                    type: 'string',
                  },
                },
                required: ['role', 'content'],
              },
              description: 'Array of messages for the conversation',
            },
            temperature: {
              type: 'number',
              description: 'Sampling temperature (0-2)',
              default: 1.0,
            },
            max_output_tokens: {
              type: 'number',
              description: 'Maximum tokens in response',
              default: 2500,
            },
          },
          required: ['messages'],
        },
      },
      {
        name: 'list_models',
        description: 'List available OpenAI and Gemini models',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'wall_bounce_chat',
        description: 'Wall bounce conversation - automatic back-and-forth discussion with AI models for brainstorming and problem-solving',
        inputSchema: {
          type: 'object',
          properties: {
            topic: {
              type: 'string',
              description: 'Topic or question to discuss',
            },
            model1: {
              type: 'string',
              description: 'First AI model to use (OpenAI model name)',
              default: process.env.OPENAI_MODEL || 'gpt-4',
            },
            model2: {
              type: 'string',
              description: 'Second AI model to use (Gemini model name)',
              default: process.env.GEMINI_MODEL || 'gemini-2.0-flash-001',
            },
            rounds: {
              type: 'number',
              description: 'Number of discussion rounds',
              default: 3,
            },
            temperature: {
              type: 'number',
              description: 'Sampling temperature (0-2)',
              default: 0.8,
            },
          },
          required: ['topic'],
        },
      },
    ],
  };
});

// Input validation helper
function validateAndSanitizeInput(input, maxLength = 10000) {
  if (!input || typeof input !== 'string') {
    throw new Error('Input must be a non-empty string');
  }
  
  // Basic sanitization - remove potentially harmful characters
  const sanitized = input.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim();
  
  if (sanitized.length === 0) {
    throw new Error('Input cannot be empty after sanitization');
  }
  
  if (sanitized.length > maxLength) {
    throw new Error(`Input too long. Maximum ${maxLength} characters allowed`);
  }
  
  return sanitized;
}

// Helper function to convert and validate messages
function convertAndValidateMessages(messages) {
  return messages.map(msg => {
    if (!msg.content || typeof msg.content !== 'string') {
      throw new Error('Message content must be a non-empty string');
    }
    
    const sanitizedContent = validateAndSanitizeInput(msg.content);
    
    if (msg.role === 'system') {
      return { role: 'system', content: sanitizedContent };
    } else if (msg.role === 'user') {
      return { role: 'user', content: sanitizedContent };
    } else if (msg.role === 'assistant') {
      return { role: 'model', content: sanitizedContent };
    }
    
    return { ...msg, content: sanitizedContent };
  });
}

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === 'chat_with_gpt') {
      const model = args.model || process.env.OPENAI_MODEL || 'gpt-4';
      const messages = args.messages;
      let temperature = args.temperature || 1.0;
      const max_tokens = args.max_tokens || 2500;

      console.error(`Calling OpenAI ${model}...`);
      
      // GPT-5シリーズはtemperature=1のみサポート
      if (model.includes('gpt-5')) {
        if (temperature !== 1) {
          console.error(`Note: ${model} only supports temperature=1, adjusting...`);
          temperature = 1;
        }
      }
      
      // パラメータの構築
      const params = {
        model,
        messages,
        temperature,
      };
      
      // GPT-5シリーズはmax_completion_tokensを使用
      if (model.includes('gpt-5')) {
        params.max_completion_tokens = max_tokens;
      } else {
        params.max_tokens = max_tokens;
      }
      
      const completion = await openai.chat.completions.create(params);

      const response = completion.choices[0].message;
      
      return {
        content: [
          {
            type: 'text',
            text: `**Model:** ${model}\n**Response:** ${response.content}`,
          },
        ],
      };
    } else if (name === 'chat_with_gemini') {
      if (!genAI) {
        throw new Error('Gemini integration not available. Please configure GOOGLE_API_KEY.');
      }
      
      const modelName = args.model || process.env.GEMINI_MODEL || 'gemini-2.0-flash-001';
      const messages = args.messages;
      const temperature = args.temperature || 1.0;
      const maxOutputTokens = args.max_output_tokens || 2500;

      console.error(`Calling Google Gemini ${modelName}...`);
      
      // Convert and validate messages
      const convertedMessages = convertAndValidateMessages(messages);
      
      const result = await genAI.models.generateContent({
        model: modelName,
        contents: convertedMessages,
        config: {
          temperature,
          maxOutputTokens,
        }
      });
      
      const response = result.text;
      
      return {
        content: [
          {
            type: 'text',
            text: `**Model:** ${modelName}\n**Response:** ${response}`,
          },
        ],
      };
    } else if (name === 'list_models') {
      const openaiModels = await openai.models.list();
      const openaiModelList = openaiModels.data
        .filter(m => m.id.includes('gpt'))
        .map(m => `- ${m.id}`)
        .join('\n');
      
      const geminiModels = [
        'gemini-2.0-flash-001',
        'gemini-1.5-pro-latest',
        'gemini-1.5-pro-002',
        'gemini-1.5-flash-001',
        'gemini-1.5-flash-002'
      ];
      const geminiModelList = geminiModels.map(m => `- ${m}`).join('\n');
      
      return {
        content: [
          {
            type: 'text',
            text: `**Available OpenAI GPT models:**\n${openaiModelList}\n\n**Available Google Gemini models:**\n${geminiModelList}`,
          },
        ],
      };
    } else if (name === 'wall_bounce_chat') {
      if (!genAI) {
        throw new Error('Wall bounce chat requires both OpenAI and Google API keys. Please configure GOOGLE_API_KEY.');
      }
      
      const topic = validateAndSanitizeInput(args.topic, 1000);
      const model1 = args.model1 || process.env.OPENAI_MODEL || 'gpt-4';
      const model2 = args.model2 || process.env.GEMINI_MODEL || 'gemini-2.0-flash-001';
      const rounds = Math.min(Math.max(args.rounds || 3, 1), 10); // Limit rounds between 1-10
      const temperature = Math.min(Math.max(args.temperature || 0.8, 0), 2); // Clamp temperature between 0-2

      console.error(`Starting wall bounce chat between ${model1} and ${model2} for ${rounds} rounds...`);
      
      let conversation = [];
      let discussionLog = `# Wall Bounce Discussion: ${topic}\n\n`;
      
      // Initial prompt for the first model
      const initialPrompt = `あなたは技術的な議論や問題解決に参加している専門家です。以下のトピックについて、建設的で洞察に富んだ議論を行ってください。別のAIモデルとの対話を通じて、アイデアを発展させ、新しい視点を提供してください。

トピック: ${topic}

このトピックについてあなたの最初の見解や質問を述べてください。`;

      conversation.push({ role: 'user', content: initialPrompt });
      
      try {
        for (let round = 1; round <= rounds; round++) {
          discussionLog += `## Round ${round}\n\n`;
          
          // OpenAI model response
          console.error(`Round ${round}: Calling ${model1}...`);
          const openaiParams = {
            model: model1,
            messages: conversation,
            temperature,
            max_tokens: 1500,
          };
          
          if (model1.includes('gpt-5')) {
            openaiParams.max_completion_tokens = 1500;
            delete openaiParams.max_tokens;
            openaiParams.temperature = 1; // GPT-5 only supports temperature=1
          }
          
          const openaiCompletion = await openai.chat.completions.create(openaiParams);
          const openaiResponse = openaiCompletion.choices[0].message.content;
          
          discussionLog += `### ${model1}:\n${openaiResponse}\n\n`;
          conversation.push({ role: 'assistant', content: openaiResponse });
          
          // Prepare prompt for Gemini
          const geminiPrompt = `あなたは技術的な議論に参加している別の専門家です。前のAIモデルの発言に対して応答し、議論を発展させてください。異なる視点や代替案を提供し、建設的な対話を続けてください。

前のモデルの発言:
"${openaiResponse}"

この発言に対するあなたの応答、質問、または追加の洞察を提供してください。`;
          
          // Gemini model response
          console.error(`Round ${round}: Calling ${model2}...`);
          const geminiResult = await genAI.models.generateContent({
            model: model2,
            contents: [{ role: 'user', content: geminiPrompt }],
            config: {
              temperature,
              maxOutputTokens: 1500,
            }
          });
          
          const geminiResponse = geminiResult.text;
          discussionLog += `### ${model2}:\n${geminiResponse}\n\n`;
          
          // Update conversation for next round
          conversation.push({ role: 'user', content: `別の専門家からの応答: "${geminiResponse}"\n\nこの応答を踏まえて、さらに議論を発展させてください。` });
        }
        
        discussionLog += `## Summary\n\nこの壁打ちセッションでは、${model1}と${model2}が${rounds}ラウンドにわたって「${topic}」について議論しました。両モデルが異なる視点と専門知識を提供し、包括的な対話が行われました。`;
        
        return {
          content: [
            {
              type: 'text',
              text: discussionLog,
            },
          ],
        };
      } catch (error) {
        console.error('Wall bounce error:', error);
        return {
          content: [
            {
              type: 'text',
              text: `壁打ちセッション中にエラーが発生しました: ${error.message}\n\n現在までの議論:\n${discussionLog}`,
            },
          ],
        };
      }
    } else {
      throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    console.error('Error:', error);
    return {
      content: [
        {
          type: 'text',
          text: `Error: ${error.message}`,
        },
      ],
    };
  }
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('MCP OpenAI ChatGPT server started');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

