# Claude Code WebUI

Web interface wrapper for Claude Code CLI tool, designed for secure demonstration to colleagues.

## Architecture

- **Frontend**: React + xterm.js + socket.io
- **Backend**: Node.js + Express + WebSocket
- **Security**: JWT authentication + SSL/TLS + Input validation

## Project Structure

```
claude-code-webui/
├── server/
│   ├── index.js              # Main server entry
│   ├── config/               # Configuration files
│   ├── middleware/           # Auth, validation middleware
│   ├── controllers/          # Route handlers
│   └── package.json
├── client/
│   ├── src/
│   │   ├── components/       # React components
│   │   └── services/         # API services
│   ├── public/
│   └── package.json
└── README.md
```

## Security Features

- SSL/TLS encryption
- JWT-based authentication
- Command input validation
- Session management with timeout
- Request rate limiting
- Comprehensive audit logging

## Quick Start

### Development Setup

1. **Install dependencies:**
   ```bash
   npm install
   cd server && npm install
   cd ../client && npm install
   ```

2. **Configure environment:**
   ```bash
   cp server/.env.example server/.env
   # Edit server/.env with your settings
   ```

3. **Build TypeScript:**
   ```bash
   cd server && npm run build
   ```

4. **Start development:**
   ```bash
   # From project root
   npm run dev
   # Or start individually:
   # Terminal 1: cd server && npm run dev
   # Terminal 2: cd client && npm run dev
   ```

### Production Deployment

#### Option 1: Docker Compose (Recommended)
```bash
# Generate SSL certificates for development
cd nginx/ssl
openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -days 365 -nodes \
  -subj "/C=US/ST=State/L=City/O=Organization/CN=localhost"
cd ../..

# Start all services (accessible at https://localhost:443)
docker-compose up -d

# View logs
docker-compose logs -f

# Stop services
docker-compose down
```

#### Option 2: Manual Deployment
```bash
# Build server
cd server && npm run build

# Start server
cd server && npm start

# Build client (in another terminal)
cd client && npm run build
```

### Testing the Setup

**Production (Docker with HTTPS):**
```bash
# Health Check
curl -k https://localhost:443/health

# Login Test
curl -k -X POST https://localhost:443/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"demo","password":"demo123"}'

# Web Interface
# Open browser to https://localhost:443
# Login with demo/demo123 or admin/admin456
```

**Development (Direct Node.js):**
```bash
# Health Check
curl http://localhost:3001/health

# Web Interface (if client running)
# Open browser to http://localhost:3000
```

## Environment Variables

- `PORT`: Server port (default: 443)
- `JWT_SECRET`: JWT signing secret
- `CLAUDE_CODE_PATH`: Path to Claude Code executable
- `SESSION_TIMEOUT`: Session timeout in minutes
- `SSL_CERT_PATH`: SSL certificate path
- `SSL_KEY_PATH`: SSL private key path

## Production Deployment

- Use nginx as reverse proxy
- Enable SSL/TLS
- Configure IP whitelisting
- Set up log rotation
- Monitor resource usage