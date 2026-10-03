import { createApp } from './app.js';
import { configuredToken, MIN_TOKEN_LENGTH } from './auth.js';
import { toolDefinitions, callTool } from './tools.js';
import { listProjects, loadProject } from './projects.js';

const PORT = parseInt(process.env.PORT || '19789', 10);

const app = createApp({ toolDefinitions, callTool, listProjects, loadProject });

// ─── Start ────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  const locked = configuredToken() === null;
  console.log(`
╔══════════════════════════════════════════════════╗
║       Meraki Video Studio — MCP Server           ║
║       Where Soul Meets Software                  ║
╠══════════════════════════════════════════════════╣
║  MCP endpoint: http://localhost:${PORT}/mcp       ║
║  Health:       http://localhost:${PORT}/health    ║
╠══════════════════════════════════════════════════╣
║  Every route but /health needs the token:        ║
║  claude mcp add --transport http \\              ║
║    meraki-studio http://127.0.0.1:${PORT}/mcp \\  ║
║    --header "Authorization: Bearer <token>"      ║
╚══════════════════════════════════════════════════╝
  `);
  if (locked) {
    console.warn(`[auth] STUDIO_API_TOKEN is missing or shorter than ${MIN_TOKEN_LENGTH} characters. The server is locked: every request except /health is refused until it is set.`);
  } else {
    console.log('[auth] token gate is on.');
  }
});
