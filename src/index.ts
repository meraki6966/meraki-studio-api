import express from 'express';
import cors from 'cors';
import { toolDefinitions, callTool } from './tools.js';
import type { MCPRequest, MCPResponse } from './types.js';
import { listProjects, loadProject } from './projects.js';

const app = express();
const PORT = parseInt(process.env.PORT || '19789', 10);
const MCP_VERSION = '2024-11-05';

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'] }));
app.use(express.json({ limit: '50mb' }));

// ─── Health check ────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'meraki-video-studio',
    version: '1.0.0',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// ─── REST API for the React UI ───────────────────────────────────────
app.get('/api/projects', (_req, res) => {
  const projects = listProjects();
  res.json({ projects });
});

app.get('/api/projects/:id', (req, res) => {
  const project = loadProject(req.params.id);
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
          result: { tools: toolDefinitions },
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

        const result = await callTool(params.name, params.arguments || {});
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

// ─── Start ────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════╗
║       Meraki Video Studio — MCP Server           ║
║       Where Soul Meets Software                  ║
╠══════════════════════════════════════════════════╣
║  MCP endpoint: http://localhost:${PORT}/mcp       ║
║  Health:       http://localhost:${PORT}/health    ║
╠══════════════════════════════════════════════════╣
║  Connect with Claude Code:                       ║
║  claude mcp add --transport http \\              ║
║    meraki-studio http://127.0.0.1:${PORT}/mcp    ║
╚══════════════════════════════════════════════════╝
  `);
});
