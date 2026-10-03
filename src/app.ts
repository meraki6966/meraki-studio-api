import express from 'express';
import cors from 'cors';
import type { ErrorRequestHandler } from 'express';
import type { MCPRequest, MCPResponse, ToolCallResult, ToolDefinition, Project } from './types.js';
import { configuredToken, requireToken } from './auth.js';

const MCP_VERSION = '2024-11-05';

/**
 * Everything the routes need is passed in, so the tests can run the real
 * routes and the real token gate against stand-ins for the tools.
 */
export interface AppDeps {
  toolDefinitions: ToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<ToolCallResult>;
  listProjects: () => Project[];
  loadProject: (id: string) => Project | null;
  token?: () => string | null;
  log?: (line: string) => void;
}

export function createApp(deps: AppDeps) {
  const app = express();
  app.disable('x-powered-by');

  app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'] }));

  // ─── Health check: the only route that needs no token ────────────────
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'meraki-video-studio',
      version: '1.0.0',
      locked: (deps.token ?? configuredToken)() === null,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  });

  // ─── Token gate ──────────────────────────────────────────────────────
  // Placed before the body parser on purpose: a caller without the token is
  // turned away before the server reads up to 50 MB of their request.
  app.use(requireToken(deps.token ?? (() => configuredToken()), deps.log));

  app.use(express.json({ limit: '50mb' }));

  // ─── REST API for the React UI ───────────────────────────────────────
  app.get('/api/projects', (_req, res) => {
    res.json({ projects: deps.listProjects() });
  });

  app.get('/api/projects/:id', (req, res) => {
    const project = deps.loadProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    res.json({ project });
  });

  // ─── MCP HTTP Transport ──────────────────────────────────────────────
  app.post('/mcp', async (req, res) => {
    const body = req.body as MCPRequest;

    // Handle batch requests
    if (Array.isArray(body)) {
      const responses = await Promise.all(body.map(r => handleMCPRequest(r)));
      return res.json(responses.filter(r => r !== null));
    }

    const response = await handleMCPRequest(body);

    // Notifications have no id and need no response
    if (response === null) {
      return res.status(202).end();
    }

    res.json(response);
  });

  async function handleMCPRequest(req: MCPRequest): Promise<MCPResponse | null> {
    // Notifications (no id field) — just acknowledge
    if (req.id === undefined && req.method?.startsWith('notifications/')) {
      return null;
    }

    const id = req.id ?? null;

    try {
      switch (req.method) {
        case 'initialize': {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: MCP_VERSION,
              capabilities: { tools: { listChanged: false } },
              serverInfo: {
                name: 'meraki-video-studio',
                version: '1.0.0',
                description: 'AI-powered video studio by Meraki is Love',
              },
            },
          };
        }

        case 'tools/list': {
          return {
            jsonrpc: '2.0',
            id,
            result: { tools: deps.toolDefinitions },
          };
        }

        case 'tools/call': {
          const params = req.params as { name: string; arguments?: Record<string, unknown> };
          if (!params?.name) {
            return {
              jsonrpc: '2.0',
              id,
              error: { code: -32602, message: 'Invalid params: missing tool name' },
            };
          }

          const result = await deps.callTool(params.name, params.arguments || {});
          return { jsonrpc: '2.0', id, result };
        }

        case 'ping': {
          return { jsonrpc: '2.0', id, result: {} };
        }

        default: {
          return {
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: `Method not found: ${req.method}` },
          };
        }
      }
    } catch (error) {
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: `Internal error: ${(error as Error).message}` },
      };
    }
  }

  // A malformed body gets a plain JSON answer, never a stack trace.
  const onError: ErrorRequestHandler = (error, _req, res, _next) => {
    const status = typeof error?.status === 'number' && error.status >= 400 && error.status < 500 ? error.status : 500;
    res.status(status).json({ error: status === 500 ? 'Server error' : 'Bad request' });
  };
  app.use(onError);

  return app;
}
