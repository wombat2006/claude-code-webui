import { getErrorMessage, toError } from '../utils/errorHandling';
import { Request, Response, NextFunction } from 'express';
import { workloadDistributor } from '../services/workloadDistributor';
import logger from '../config/logger';

interface ProxyConfig {
  routes: {
    [key: string]: {
      taskType: string;
      extractPayload: (req: Request) => any;
      timeout?: number;
      fallbackLocal?: boolean;
    }
  };
}

export class WorkloadProxy {
  private config: ProxyConfig;

  constructor() {
    this.config = {
      routes: {
        // Context7 operations
        'POST:/api/context7/resolve': {
          taskType: 'context7',
          extractPayload: (req) => ({ operation: 'resolve-library', ...req.body }),
          timeout: 30000
        },
        'GET:/api/context7/docs/:libraryId': {
          taskType: 'context7', 
          extractPayload: (req) => ({ operation: 'get-docs', libraryId: req.params.libraryId }),
          timeout: 60000
        },
        'GET:/api/context7/search': {
          taskType: 'context7',
          extractPayload: (req) => ({ operation: 'search', query: req.query.q, limit: req.query.limit }),
          timeout: 30000
        },

        // Claude Code operations
        'POST:/api/claude/execute': {
          taskType: 'claude-code',
          extractPayload: (req) => ({ command: req.body.command, session: req.body.session }),
          timeout: 120000
        },

        // File operations  
        'GET:/api/files/read': {
          taskType: 'file-read',
          extractPayload: (req) => ({ path: req.query.path, encoding: req.query.encoding }),
          timeout: 30000
        },
        'POST:/api/files/search': {
          taskType: 'file-search',
          extractPayload: (req) => ({ pattern: req.body.pattern, directory: req.body.directory }),
          timeout: 60000
        },

        // Code analysis
        'POST:/api/code/analyze': {
          taskType: 'code-analysis',
          extractPayload: (req) => ({ files: req.body.files, analysisType: req.body.type }),
          timeout: 180000
        },
        'POST:/api/code/lint': {
          taskType: 'linting',
          extractPayload: (req) => ({ files: req.body.files, linter: req.body.linter }),
          timeout: 120000
        },

        // Build operations
        'POST:/api/build/compile': {
          taskType: 'compilation',
          extractPayload: (req) => ({ project: req.body.project, target: req.body.target }),
          timeout: 300000
        },
        'POST:/api/build/test': {
          taskType: 'testing',
          extractPayload: (req) => ({ suite: req.body.suite, files: req.body.files }),
          timeout: 240000
        },

        // AI operations
        'POST:/api/ai/completion': {
          taskType: 'llm-call',
          extractPayload: (req) => ({ model: req.body.model, prompt: req.body.prompt, options: req.body.options }),
          timeout: 120000
        },
        'POST:/api/ai/embedding': {
          taskType: 'embedding',
          extractPayload: (req) => ({ text: req.body.text, model: req.body.model }),
          timeout: 60000
        },

        // MCP operations
        'POST:/api/mcp/:server/:function': {
          taskType: 'mcp-call',
          extractPayload: (req) => ({ server: req.params.server, function: req.params.function, params: req.body }),
          timeout: 90000
        },

        // Web operations
        'POST:/api/web/fetch': {
          taskType: 'web-scraping',
          extractPayload: (req) => ({ url: req.body.url, options: req.body.options }),
          timeout: 60000
        }
      }
    };
  }

  /**
   * Middleware to intercept and potentially proxy requests to workers
   */
  proxyMiddleware() {
    return async (req: Request, res: Response, next: NextFunction) => {
      const routeKey = `${req.method}:${req.route?.path || req.path}`;
      const route = this.config.routes[routeKey];

      if (!route) {
        // No proxy configuration for this route, continue normally
        return next();
      }

      try {
        logger.info(`Proxying request: ${routeKey}`);

        const payload = route.extractPayload(req);
        const options = {
          timeout: route.timeout || 60000,
          fallbackLocal: route.fallbackLocal !== false,
          originalRequest: {
            method: req.method,
            path: req.path,
            headers: req.headers,
            ip: req.ip
          }
        };

        const result = await workloadDistributor.executeTask(route.taskType, payload, options);
        
        // Send the result directly to client
        res.json({
          success: true,
          result,
          distributed: true,
          taskType: route.taskType
        });

      } catch (error) {
        logger.error(`Proxy error for ${routeKey}:`, toError(error));
        
        // Send error response
        res.status(500).json({
          success: false,
          error: getErrorMessage(error),
          taskType: route.taskType,
          distributed: true
        });
      }
    };
  }

  /**
   * Add a new route to proxy configuration
   */
  addRoute(method: string, path: string, config: any): void {
    const routeKey = `${method.toUpperCase()}:${path}`;
    this.config.routes[routeKey] = config;
    logger.info(`Added proxy route: ${routeKey}`);
  }

  /**
   * Remove a route from proxy configuration  
   */
  removeRoute(method: string, path: string): void {
    const routeKey = `${method.toUpperCase()}:${path}`;
    delete this.config.routes[routeKey];
    logger.info(`Removed proxy route: ${routeKey}`);
  }

  /**
   * Get proxy statistics
   */
  getStats(): any {
    const routes = Object.keys(this.config.routes);
    return {
      totalRoutes: routes.length,
      routes: routes,
      distributorStats: workloadDistributor.getStats()
    };
  }
}

// Utility function to create proxy for specific controller methods
export function proxyControllerMethod(taskType: string, timeout: number = 60000) {
  return function(target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;

    descriptor.value = async function(...args: any[]) {
      const req = args[0] as Request;
      const res = args[1] as Response;

      try {
        // Extract payload from request
        const payload = {
          body: req.body,
          params: req.params, 
          query: req.query,
          method: propertyKey
        };

        const result = await workloadDistributor.executeTask(taskType, payload, { timeout });
        
        res.json({
          success: true,
          result,
          distributed: true
        });

      } catch (error) {
        logger.error(`Proxied method ${propertyKey} failed:`, toError(error));
        
        // Fallback to original method if configured
        if (process.env.PROXY_FALLBACK === 'true') {
          return originalMethod.apply(this, args);
        }

        res.status(500).json({
          success: false,
          error: getErrorMessage(error),
          distributed: true
        });
      }
    };

    return descriptor;
  };
}

export const workloadProxy = new WorkloadProxy();