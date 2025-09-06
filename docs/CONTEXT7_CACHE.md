# Context7 Redis Cache

This document describes the Redis caching system for Context7 metadata to optimize performance and reduce API calls.

## Overview

Context7 MCP server provides up-to-date documentation for libraries and frameworks, but it returns full library lists every time. To optimize this, we've implemented a Redis cache layer that:

- Caches library metadata and documentation
- Reduces redundant API calls to Context7
- Improves response times for repeated queries
- Provides configurable TTL (Time To Live) for cache entries

## Architecture

```
Client → API Endpoint → Context7 Cache → Redis
                    ↓
                    Context7 MCP Server (when cache miss)
```

## Configuration

Add these environment variables to your `.env` file:

```bash
# Context7 Cache Configuration
REDIS_URL=redis://localhost:6379
CONTEXT7_CACHE_TTL=3600        # Cache TTL in seconds (1 hour)
CONTEXT7_MAX_LIBRARIES=1000    # Maximum libraries to cache per query
```

## API Endpoints

### 1. Resolve Library
**POST** `/api/context7/resolve`

Resolves a library name to a Context7-compatible library ID.

```bash
curl -X POST https://localhost:443/api/context7/resolve \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query": "react"}'
```

Response:
```json
{
  "success": true,
  "query": "react",
  "library": {
    "id": "/facebook/react",
    "name": "React",
    "version": "18.2.0",
    "description": "A JavaScript library for building user interfaces"
  },
  "cached": true
}
```

### 2. Get Library Documentation
**GET** `/api/context7/docs/:libraryId`

Fetches documentation for a specific library.

```bash
curl -X GET https://localhost:443/api/context7/docs/facebook/react \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

Response:
```json
{
  "success": true,
  "libraryId": "facebook/react",
  "docs": "# React Documentation\n\nReact is a JavaScript library...",
  "cached": true
}
```

### 3. Search Libraries
**GET** `/api/context7/search?q=QUERY&limit=50`

Search for libraries matching a query.

```bash
curl -X GET "https://localhost:443/api/context7/search?q=react&limit=10" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

Response:
```json
{
  "success": true,
  "query": "react",
  "libraries": [
    {
      "id": "/facebook/react",
      "name": "React",
      "version": "18.2.0"
    }
  ],
  "total": 1,
  "cached": true
}
```

### 4. Cache Statistics
**GET** `/api/context7/cache/stats`

Get information about the cache status.

```bash
curl -X GET https://localhost:443/api/context7/cache/stats \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

Response:
```json
{
  "success": true,
  "cache": {
    "connected": true,
    "totalKeys": 42,
    "libraryListEntries": 15,
    "libraryDocsEntries": 27,
    "ttl": 3600
  }
}
```

### 5. Clear Cache
**DELETE** `/api/context7/cache`

Clear all cached Context7 data.

```bash
curl -X DELETE https://localhost:443/api/context7/cache \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

Response:
```json
{
  "success": true,
  "message": "Cache cleared successfully"
}
```

## Cache Strategy

### Cache Keys
- **Library Lists**: `context7:library-list:BASE64_ENCODED_QUERY`
- **Library Docs**: `context7:library-docs:BASE64_ENCODED_LIBRARY_ID`

### TTL Configuration
- **Library Lists**: Full TTL (default: 1 hour)
- **Library Docs**: Half TTL (default: 30 minutes)

### Cache Behavior
1. **Cache Hit**: Return cached data immediately
2. **Cache Miss**: Call Context7 MCP server, cache the result, return data
3. **Cache Expiry**: Automatic cleanup after TTL expires

## Redis Setup

### Local Development
```bash
# Install Redis
sudo apt-get install redis-server

# Start Redis
sudo systemctl start redis-server

# Test connection
redis-cli ping
```

### Production with Docker
```yaml
# docker-compose.yml
version: '3.8'
services:
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data
    command: redis-server --appendonly yes

volumes:
  redis_data:
```

## Error Handling

The cache service gracefully handles Redis connection issues:

- **Redis Down**: Falls back to direct Context7 calls
- **Cache Miss**: Calls Context7 MCP server and caches result
- **Invalid Data**: Logs error and continues without caching

## Monitoring

### Log Messages
- `Context7 Cache: Connected to Redis`
- `Context7 Cache: Library list cache hit for query: react`
- `Context7 Cache: Cached 150 libraries for query: javascript`
- `Context7 Cache: Redis error: Connection failed`

### Performance Metrics
Monitor these metrics in your logs:
- Cache hit/miss ratios
- Response times with/without cache
- Redis connection health
- Cache key count and memory usage

## Best Practices

1. **TTL Tuning**: Adjust TTL based on how frequently documentation changes
2. **Memory Management**: Monitor Redis memory usage and set appropriate limits
3. **Key Cleanup**: Use Redis EXPIRE for automatic cleanup
4. **Monitoring**: Set up alerts for Redis connection failures
5. **Backup**: Consider Redis persistence for important cache data

## Troubleshooting

### Common Issues

**Cache not working**
- Check Redis connection: `redis-cli ping`
- Verify REDIS_URL environment variable
- Check server logs for connection errors

**High memory usage**
- Reduce CONTEXT7_MAX_LIBRARIES
- Decrease CONTEXT7_CACHE_TTL
- Clear cache: `DELETE /api/context7/cache`

**Stale data**
- Clear specific cache entries
- Reduce TTL for more frequent updates
- Use manual cache invalidation

### Debug Commands
```bash
# Check Redis keys
redis-cli KEYS "context7:*"

# Get cache statistics
redis-cli INFO memory

# Monitor cache activity
redis-cli MONITOR
```

## Security

- All endpoints require JWT authentication
- Redis connection should use AUTH in production
- Consider Redis over TLS for network security
- Implement proper firewall rules for Redis port