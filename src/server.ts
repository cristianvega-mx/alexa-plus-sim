import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent } from './agent.js';
import { McpBridge, type FormAnswer } from './mcp.js';

const port = Number(process.env.PORT ?? 4000);
const language = process.env.SIM_LANGUAGE ?? 'es-MX';
const mcpUrl = new URL(process.env.MCP_SERVER_URL ?? 'http://127.0.0.1:3000/mcp');
const publicDir = fileURLToPath(new URL('../public/', import.meta.url));

// Everything the screen needs arrives as Server-Sent Events; one kitchen, so every open tab sees the same device.
const screens = new Set<ServerResponse>();
function broadcast(event: Record<string, unknown>): void {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const screen of screens) screen.write(data);
}

const mcp = new McpBridge(mcpUrl, form => broadcast({ type: 'form', ...form }));
const agent = new Agent(mcp, language, {
  toolCall: (name, args) => broadcast({ type: 'tool-call', name, args }),
  toolResult: (name, result) =>
    broadcast({ type: 'tool-result', name, isError: result.isError === true, data: result.structuredContent ?? null }),
  say: text => broadcast({ type: 'say', text })
});

let busy = false;
// \b does not work after accented letters ("sí"), so the words end at the first non-letter instead.
const yes = /^(s[ií]|claro|ok|okay|de acuerdo|gu[aá]rd[ae]lo|adelante|yes)(?!\p{L})/iu;
const no = /^(no|cancela|cancelar|mejor no)(?!\p{L})/iu;

async function handleUtterance(text: string): Promise<void> {
  broadcast({ type: 'user', text });
  // A spoken yes/no answers a form that is on screen, with the choices already selected.
  const openForm = mcp.openFormId;
  if (openForm) {
    const answer: FormAnswer | undefined = yes.test(text) ? { action: 'accept' } : no.test(text) ? { action: 'decline' } : undefined;
    if (answer) {
      broadcast({ type: 'form-voice-answer', id: openForm, action: answer.action });
      return;
    }
  }
  if (busy) {
    broadcast({ type: 'say', text: 'Un momento, sigo con lo anterior.' });
    return;
  }
  busy = true;
  broadcast({ type: 'thinking', on: true });
  try {
    await agent.turn(text);
  } catch (error) {
    console.error(error);
    broadcast({ type: 'say', text: 'Perdón, tuve un problema. ¿Me lo repite?' });
  } finally {
    busy = false;
    broadcast({ type: 'thinking', on: false });
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 64_000) throw new Error('Body too large');
  }
  return body ? (JSON.parse(body) as Record<string, unknown>) : {};
}

const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml'
};

async function serveStatic(path: string, res: ServerResponse): Promise<void> {
  const name = path === '/' ? 'index.html' : path.slice(1);
  if (!/^[\w.-]+$/.test(name)) {
    res.writeHead(404).end();
    return;
  }
  try {
    const file = await readFile(join(publicDir, name));
    res.writeHead(200, { 'content-type': types[extname(name)] ?? 'application/octet-stream' }).end(file);
  } catch {
    res.writeHead(404).end();
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  try {
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ type: 'hello', server: mcp.serverName, language, tools: mcp.tools.map(t => t.name) })}\n\n`);
      screens.add(res);
      req.on('close', () => screens.delete(res));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/utterance') {
      const { text } = await readJson(req);
      if (typeof text !== 'string' || !text.trim()) {
        res.writeHead(400).end();
        return;
      }
      void handleUtterance(text.trim());
      res.writeHead(202).end();
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/form') {
      const { id, action, content } = await readJson(req);
      const answer = { action, content } as FormAnswer;
      const ok = typeof id === 'string' && ['accept', 'decline', 'cancel'].includes(String(action)) && mcp.answerForm(id, answer);
      if (ok) broadcast({ type: 'form-closed', id });
      res.writeHead(ok ? 204 : 404).end();
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/reset') {
      agent.reset();
      broadcast({ type: 'reset' });
      res.writeHead(204).end();
      return;
    }
    if (req.method === 'GET') {
      await serveStatic(url.pathname, res);
      return;
    }
    res.writeHead(405).end();
  } catch (error) {
    console.error(error);
    if (!res.headersSent) res.writeHead(500).end();
  }
});

await mcp.connect();
server.listen(port, '127.0.0.1', () => {
  console.log(`Alexa+ simulator on http://127.0.0.1:${port} — skill "${mcp.serverName}" with ${mcp.tools.length} tools`);
});
