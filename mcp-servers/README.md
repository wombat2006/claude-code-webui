# MCP Servers Collection

This directory contains copies of available MCP servers found on the system.

## Copied MCP Servers

### 1. Cipher MCP Server ⚡ MEMORY FRAMEWORK
- **Location**: `./cipher-mcp-server/` + `../cipher-framework/`
- **Original**: `/ai/mcp/cipher-mcp-server/`
- **Purpose**: Memory-powered AI agent framework with long-term memory and reminder capabilities
- **Functions**: `mcp__cipher__ask_cipher`
- **Core Features**:
  - 🧠 **Dual Memory System**: System 1 (Programming Concepts & Business Logic) + System 2 (AI Reasoning Steps)
  - 🔄 **Cross-IDE Memory**: Switch between Cursor, Windsurf, Claude Desktop, VS Code, etc. without losing context
  - 🤝 **Team Memory Sharing**: Real-time memory sharing across development teams
  - 📊 **Multiple Vector Databases**: Chroma, Faiss, Milvus, Pinecone, Qdrant, Weaviate, Redis, PostgreSQL
  - 🔗 **Knowledge Graph**: Neo4j integration for relationship mapping
  - 📝 **Session Persistence**: SQLite-based session storage
  - 🌐 **WebSocket Real-time**: Live memory synchronization
  - 🎯 **MCP Integration**: Compatible with all major AI coding assistants

### 2. Serena MCP Server
- **Location**: `./serena/`
- **Original**: `/ai/mcp/serena/`
- **Purpose**: Coding agent toolkit with IDE-like capabilities
- **Features**:
  - Semantic code retrieval
  - Symbol-level code editing
  - Code entity extraction
  - Find symbols and references
  - Insert/edit code at symbol level

### 3. ChatGPT MCP Server ✅ FOUND
- **Location**: `./chatgpt-mcp-server.js`
- **Original**: `/ai/prj/wall-bounce-tech-support-helper/openai-mcp.js`
- **Purpose**: Direct OpenAI GPT and Google Gemini API integration
- **Functions**: `mcp__mcp-server-chatgpt__chat_with_gpt`
- **Features**:
  - Chat with GPT models (GPT-5, GPT-4, etc.)
  - Chat with Gemini models (gemini-2.5-pro, gemini-2.0-flash, etc.)
  - Wall bounce conversations (multi-model discussions)
  - List available models
  - Japanese language support
  - Temperature control and token limits

### 4. Wall Bounce Tech Support Helper ✅ FOUND
- **Location**: `./wall-bounce-tech-support-helper/`
- **Original**: `/ai/prj/wall-bounce-tech-support-helper/`
- **Purpose**: Complete MCP server framework with modular architecture
- **Features**:
  - Modular provider system (OpenAI, Gemini)
  - Wall bounce service for AI model conversations
  - Tool definitions and handlers
  - Environment configuration
  - Multi-round AI discussions for problem solving

## Discovered MCP Server References

### Context7 MCP Server ✅ REFERENCED
- **Status**: ✅ Referenced in configuration
- **Functions Found**:
  - `mcp__context7__resolve-library-id`
  - `mcp__context7__get-library-docs`
- **Location**: Referenced in `./wall-bounce-tech-support-helper/.claude/settings.local.json`
- **Purpose**: Library documentation and context resolution
- **Note**: Functions exist but server source code not located

## Available vs Loaded

While these MCP servers exist as files, they are not currently loaded as callable functions in the Claude Code session. The currently available MCP functions are:

- `mcp__zen__*` - Zen MCP server tools
- `mcp__o3__*` - O3 search capabilities
- `mcp__o3-low__*` - O3 low-level search  
- `mcp__o3-high__*` - O3 high-level search

## Next Steps

To make these MCP servers available as callable functions, they would need to be:

1. Properly configured in the Claude Code MCP configuration
2. Started as running MCP server processes
3. Registered with the Claude Code session

## Cipher Framework Deep Dive

The Cipher framework (located at `../cipher-framework/`) is a comprehensive memory solution for AI coding agents:

### Architecture
- **Core Modules**: Vector databases, knowledge graphs, memory systems, intelligent processors
- **Storage Backends**: SQLite (local), PostgreSQL, Redis, Neo4j, and major vector DBs
- **Memory Types**: 
  - System 1: Immediate coding patterns, business logic, past interactions
  - System 2: AI reasoning chains, decision-making processes
  - Knowledge Graph: Code relationships and dependencies

### Integration Points
- **MCP Compatible**: Works with Cursor, Windsurf, Claude Desktop/Code, VS Code, Gemini CLI, AWS Kiro
- **API Access**: REST endpoints, WebSocket real-time updates  
- **Team Collaboration**: Multi-user memory sharing and synchronization

### Use Cases
- **Long-term Code Memory**: Remember coding patterns across sessions
- **Project Context**: Maintain understanding of large codebases
- **Team Knowledge**: Share insights and solutions across developers
- **AI Agent Enhancement**: Give persistent memory to any coding assistant

This transforms any AI coding assistant from stateless to stateful, creating a true "memory layer" for development workflows.

---

*Generated: 2025-09-06*  
*Search completed by: Claude Code*  
*Cipher Framework Analysis: Comprehensive memory-powered AI agent system*