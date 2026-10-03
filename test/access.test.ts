// Tests for who can call the Video Studio API, and for the values a caller
// supplies that end up in a file path.
// Run:  npm test
//
// Each test includes the request that has to be refused, not only the one
// that works. To prove a test can fail, break the rule it covers and run again.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { createApp } from '../src/app.ts';
import { bearerToken, configuredToken, MIN_TOKEN_LENGTH, tokensMatch } from '../src/auth.ts';
import { isProjectId, safeExtension, safeOutputName } from '../src/safe.ts';

// A throwaway value made for this run. It guards nothing outside this test.
const TOKEN = randomBytes(32).toString('hex');
const PROJECT_ID = '9b81718a-5ef2-445e-a11a-23432da8d91a';

interface Harness {
  url: string;
  calls: string[];
  log: string[];
  close: () => Promise<void>;
}

function start(token: string | null): Promise<Harness> {
  const calls: string[] = [];
  const log: string[] = [];
  const app = createApp({
    token: () => token,
    log: (line) => log.push(line),
    toolDefinitions: [{ name: 'generate_narration', description: 'stand-in', inputSchema: { type: 'object', properties: {} } }] as never,
    callTool: async (name) => {
      calls.push(name);
      return { content: [{ type: 'text', text: 'ok' }] } as never;
    },
    listProjects: () => {
      calls.push('listProjects');
      return [];
    },
    loadProject: (id) => {
      calls.push(`loadProject:${id}`);
      return null;
    },
  });
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        calls,
        log,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

const narrate = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'generate_narration', arguments: { text: 'hello' } } });
const post = (url: string, headers: Record<string, string>, body = narrate) =>
  fetch(`${url}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });

let open: Harness;
let locked: Harness;
let shortToken: Harness;

before(async () => {
  open = await start(TOKEN);
  locked = await start(null);
  shortToken = await start(configuredToken({ STUDIO_API_TOKEN: 'tooshort' } as NodeJS.ProcessEnv));
});
after(async () => {
  await Promise.all([open.close(), locked.close(), shortToken.close()]);
});

test('with no token, nothing runs: no tool, no project list, no project read', async () => {
  const before = open.calls.length;
  const cases: Array<[string, Promise<Response>]> = [
    ['tool call, no header', post(open.url, {})],
    ['tool call, wrong token', post(open.url, { Authorization: `Bearer ${'0'.repeat(64)}` })],
    ['tool call, token one character short', post(open.url, { Authorization: `Bearer ${TOKEN.slice(0, -1)}` })],
    ['tool call, right token under the wrong scheme', post(open.url, { Authorization: `Basic ${TOKEN}` })],
    ['tool call, right token with no scheme', post(open.url, { Authorization: TOKEN })],
    ['tool call, token in a custom header', post(open.url, { 'X-Api-Key': TOKEN })],
    ['tool call, token in the URL', fetch(`${open.url}/mcp?token=${TOKEN}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: narrate })],
    ['tools/list', post(open.url, {}, JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }))],
    ['initialize', post(open.url, {}, JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'initialize' }))],
    ['project list', fetch(`${open.url}/api/projects`)],
    ['project read', fetch(`${open.url}/api/projects/${PROJECT_ID}`)],
    ['unknown path', fetch(`${open.url}/anything-else`)],
  ];
  for (const [name, pending] of cases) {
    const res = await pending;
    assert.equal(res.status, 401, name);
    assert.equal(res.headers.get('www-authenticate'), 'Bearer', name);
    const body = await res.text();
    assert.equal(body.includes('stand-in'), false, name);
  }
  assert.equal(open.calls.length, before, 'a refused request reached a tool or the project store');
});

test('with the token, the same requests work', async () => {
  const call = await post(open.url, { Authorization: `Bearer ${TOKEN}` });
  assert.equal(call.status, 200);
  assert.equal((await call.json()).result.content[0].text, 'ok');
  assert.equal(open.calls.at(-1), 'generate_narration');

  const list = await post(open.url, { Authorization: `Bearer ${TOKEN}` }, JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
  assert.equal((await list.json()).result.tools.length, 1);

  const projects = await fetch(`${open.url}/api/projects`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal(projects.status, 200);
  // The header name is not case sensitive and extra spaces are tolerated.
  const lower = await post(open.url, { authorization: `Bearer   ${TOKEN}` });
  assert.equal(lower.status, 200);
});

test('a server with no token, or a short one, is locked. It never falls back to open', async () => {
  for (const h of [locked, shortToken]) {
    for (const res of [
      await post(h.url, {}),
      await post(h.url, { Authorization: `Bearer ${TOKEN}` }),
      await post(h.url, { Authorization: 'Bearer tooshort' }),
      await post(h.url, { Authorization: 'Bearer ' }),
      await fetch(`${h.url}/api/projects`),
    ]) {
      assert.equal(res.status, 503);
    }
    assert.equal(h.calls.length, 0);
  }
  assert.equal(configuredToken({} as NodeJS.ProcessEnv), null);
  assert.equal(configuredToken({ STUDIO_API_TOKEN: '   ' } as NodeJS.ProcessEnv), null);
  assert.equal(configuredToken({ STUDIO_API_TOKEN: 'x'.repeat(MIN_TOKEN_LENGTH - 1) } as NodeJS.ProcessEnv), null);
  assert.equal(configuredToken({ STUDIO_API_TOKEN: ` ${'x'.repeat(MIN_TOKEN_LENGTH)} ` } as NodeJS.ProcessEnv), 'x'.repeat(MIN_TOKEN_LENGTH));
});

test('health is the only open route, and it says whether the server is locked', async () => {
  const a = await (await fetch(`${open.url}/health`)).json();
  const b = await (await fetch(`${locked.url}/health`)).json();
  assert.equal(a.status, 'ok');
  assert.equal(a.locked, false);
  assert.equal(b.locked, true);
  assert.equal(JSON.stringify(a).includes(TOKEN), false);
});

test('a caller without the token is turned away before the body is read', async () => {
  // Not JSON at all. If the body parser ran first this would be a 400.
  const res = await fetch(`${open.url}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{ not json' });
  assert.equal(res.status, 401);
  // With the token, the same body is a plain JSON 400 with no stack trace.
  const bad = await fetch(`${open.url}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` }, body: '{ not json' });
  assert.equal(bad.status, 400);
  const text = await bad.text();
  assert.deepEqual(JSON.parse(text), { error: 'Bad request' });
  assert.equal(/node_modules|at \w+ \(/.test(text), false);
});

test('a refusal is logged with the path, and never with what was presented', async () => {
  const start = open.log.length;
  await post(open.url, { Authorization: 'Bearer this-is-a-guess-that-must-not-be-logged' });
  await post(open.url, {});
  const lines = open.log.slice(start);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /\[auth\] refused: wrong token\. POST \/mcp from /);
  assert.match(lines[1], /\[auth\] refused: no token\. POST \/mcp from /);
  assert.equal(lines.join('\n').includes('this-is-a-guess'), false);
  assert.equal(open.log.join('\n').includes(TOKEN), false);
});

test('token parsing and comparison', () => {
  assert.equal(bearerToken(`Bearer ${TOKEN}`), TOKEN);
  assert.equal(bearerToken(`bearer ${TOKEN}`), null);
  assert.equal(bearerToken(`Bearer ${TOKEN} extra`), null);
  assert.equal(bearerToken('Bearer'), null);
  assert.equal(bearerToken(undefined), null);
  assert.equal(bearerToken(['Bearer a']), null);
  assert.equal(tokensMatch(TOKEN, TOKEN), true);
  assert.equal(tokensMatch(TOKEN.toUpperCase(), TOKEN), false);
  assert.equal(tokensMatch('', TOKEN), false);
  assert.equal(tokensMatch(TOKEN + 'x', TOKEN), false);
});

test('a project id cannot walk out of the projects folder', async () => {
  for (const id of ['../../package', '..%2F..%2Fpackage', '..\\..\\package', '/etc/passwd', 'a/b', '', 'not-a-uuid', `${PROJECT_ID}/../x`, `${PROJECT_ID}.json`]) {
    assert.equal(isProjectId(id), false, id);
  }
  assert.equal(isProjectId(PROJECT_ID), true);
  assert.equal(isProjectId(PROJECT_ID.toUpperCase()), true);
  assert.equal(isProjectId(undefined), false);

  // The real project store, pointed at a scratch folder with a file one level
  // up that the old code would have returned for the id "../outside".
  const data = mkdtempSync(join(tmpdir(), 'studio-test-'));
  process.env.DATA_DIR = data;
  const store = await import('../src/projects.ts');
  writeFileSync(join(data, 'outside.json'), JSON.stringify({ leaked: true }));
  assert.equal(store.loadProject('../outside'), null);
  const made = store.createProject('Test project');
  assert.equal(isProjectId(made.id), true);
  assert.equal(store.loadProject(made.id)?.name, 'Test project');
  assert.throws(() => store.saveProject({ ...made, id: '../escaped' }), /not a UUID/);

  // Through the route, with a valid token, the traversal is a 404.
  const real = createApp({ token: () => TOKEN, log: () => {}, toolDefinitions: [], callTool: async () => ({ content: [] }) as never, listProjects: store.listProjects, loadProject: store.loadProject });
  const server = real.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const { port } = server.address() as AddressInfo;
  const res = await fetch(`http://127.0.0.1:${port}/api/projects/..%2Foutside`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal(res.status, 404);
  assert.equal((await res.text()).includes('leaked'), false);
  const found = await fetch(`http://127.0.0.1:${port}/api/projects/${made.id}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal(found.status, 200);
  await new Promise((r) => server.close(r));
});

test('an upload extension and a render name cannot carry a path', () => {
  assert.equal(safeExtension('mp4'), 'mp4');
  assert.equal(safeExtension('.MOV'), 'mov');
  assert.equal(safeExtension(undefined), 'mp4');
  for (const bad of ['mp4/../../../etc/cron.d/x', '../x', 'a b', 'toolong', '', 'mp4\0', 'm/p']) {
    assert.equal(safeExtension(bad), 'mp4', bad);
  }
  assert.equal(safeOutputName('promo_v2-final'), 'promo_v2-final');
  for (const bad of ['../../etc/x', 'a/b', 'a.b', '', 'x'.repeat(81), 5, null, undefined]) {
    assert.equal(safeOutputName(bad), undefined, String(bad));
  }
});
