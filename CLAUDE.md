# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Web UI wrapper for the Claude Code CLI tool, designed as a secure terminal interface accessible via web browser. The application consists of a React frontend and a Node.js/Express backend communicating via WebSocket connections.

## Architecture

- **Frontend**: React application with xterm.js terminal emulator and Socket.IO client
- **Backend**: TypeScript Node.js server with Express, Socket.IO, JWT authentication, and security middleware
- **Communication**: WebSocket-based real-time terminal emulation
- **Security**: JWT authentication, SSL/TLS, input validation, rate limiting, audit logging

## Development Commands

### Setup
```bash
# Install all dependencies
npm install
cd server && npm install
cd ../client && npm install

# Build TypeScript (server)
cd server && npm run build
```

### Development
```bash
# Start both client and server in development mode
npm run dev

# Or start individually:
cd server && npm run dev    # TypeScript server with hot reload
cd client && npm start      # React development server
```

### Production
```bash
# Build client for production
npm run build

# Start production server
npm start

# Docker deployment
docker-compose up -d
```

### Testing

**Development (HTTP):**
```bash
# Health check
curl http://localhost:3001/health

# Login test  
curl -X POST http://localhost:3001/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"demo","password":"demo123"}'
```

**Production (HTTPS via Docker):**
```bash
# Generate SSL certificates first (see nginx/ssl/README.md)
# Then start with Docker Compose
docker-compose up -d

# Health check
curl -k https://localhost:443/health

# Login test
curl -k -X POST https://localhost:443/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"demo","password":"demo123"}'

# Access web interface: https://localhost:443
```

## Key Architecture Components

### Backend Structure (`/server/src/`)
- `index.ts` - Main server entry point with SSL/security configuration
- `services/claudeCodeWrapper.ts` - Handles Claude Code CLI process management
- `services/socketService.ts` - WebSocket connection and session management
- `middleware/auth.ts` - JWT authentication and user management
- `middleware/security.ts` - Security headers, rate limiting, input validation
- `controllers/authController.ts` - Authentication endpoints
- `config/` - SSL, logging, and environment configuration

### Frontend Structure (`/client/src/`)
- React application with Socket.IO client for real-time terminal communication
- xterm.js integration for terminal emulation

### Security Implementation
- JWT-based session management with configurable timeout
- SSL/TLS encryption for all communications
- Request rate limiting and IP whitelisting
- Comprehensive audit logging
- Input validation and sanitization
- Command execution sandboxing

## Environment Configuration

Required environment variables (see `server/.env.example`):
- `JWT_SECRET` - JWT signing secret
- `CLAUDE_CODE_PATH` - Path to Claude Code executable
- `SSL_CERT_PATH`, `SSL_KEY_PATH` - SSL certificate paths
- `SESSION_TIMEOUT` - Session timeout in minutes
- `ALLOWED_IPS` - Comma-separated IP whitelist
- `MAX_SESSIONS` - Maximum concurrent sessions

## Development Patterns

### TypeScript Usage
- Full TypeScript implementation in backend
- Type definitions in `server/src/types/`
- Proper typing for Socket.IO events and Express middleware

### Security Patterns
- All routes protected with authentication middleware
- Command execution wrapped in security validation
- Session management with automatic cleanup
- Comprehensive error handling and logging

### WebSocket Communication
- Structured message types for terminal I/O
- Session-based command routing
- Automatic reconnection handling
- Process lifecycle management

## Deployment

### Docker Compose (Recommended)
- Multi-container setup with nginx proxy
- SSL termination and reverse proxy configuration
- Health checks and restart policies
- Volume mounting for logs and sessions

### Manual Deployment
- nginx reverse proxy required for SSL termination
- Log rotation and monitoring setup required

## Additional Documentation

- Security guidelines: @docs/SECURITY.md
- Troubleshooting: @docs/TROUBLESHOOTING.md