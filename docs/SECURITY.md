# Security Guidelines

## SSL Certificate Management

**CRITICAL SECURITY WARNING**: Never store certificates in `/root` directory.

### Proper Certificate Storage
- Store certificates in `/etc/ssl/certs/` 
- Store private keys in `/etc/ssl/private/`
- Set proper permissions:
  - Certificate files: 644
  - Private keys: 600
  - Owner: root:ssl-cert

### Process Security
- **nginx**: Run as www-data user with certificate group access
- **Node.js**: Run as non-root user on port 3001 (non-privileged)
- **SSL Termination**: Always terminate SSL at nginx, never in Node.js

### Port Configuration
- Development: Node.js on port 3001
- Production: nginx on port 443 (SSL), proxy to Node.js on 3001

## Input Validation
- Command whitelist enforcement
- Argument sanitization against injection attacks
- Path traversal protection
- Length limits and rate limiting

## Process Management
- Automatic session cleanup on disconnect
- Child process lifecycle management
- Resource limits and monitoring