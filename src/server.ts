import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FormAnswer } from './mcp.js';
import { Session } from './session.js';

const port = Number(process.env.PORT ?? 4000);
const bindAddress = process.env.SIM_BIND ?? '127.0.0.1';
const language = process.env.SIM_LANGUAGE ?? 'es-MX';
const mcpUrl = new URL(process.env.MCP_SERVER_URL ?? 'http://127.0.0.1:3000/mcp');
const publicDir = fileURLToPath(new URL('../public/', import.meta.url));

// Optional protection for a public deployment: SIM_BASIC_AUTH=user:password asks every visitor for it,
// and SIM_MAX_TURNS_PER_HOUR caps how many requests reach the model in total.
const basicAuth = process.env.SIM_BASIC_AUTH ? Buffer.from(`Basic ${Buffer.from(process.env.SIM_BASIC_AUTH).toString('base64')}`) : undefined;
const maxTurnsPerHour = Number(process.env.SIM_MAX_TURNS_PER_HOUR ?? 300);
const recentTurns: number[] = [];

// Every browser gets its own simulated device, found again through a cookie.
const sessions = new Map<string, Session>();
const sessionCookie = 'sim_session';
const idleLimitMs = 60 * 60 * 1000;

function cookieValue(req: IncomingMessage, name: string): string | undefined {
  return req.headers.cookie
    ?.split(';')
    .map(part => part.trim().split('='))
    .find(([key]) => key === name)?.[1];
}

function sessionFor(req: IncomingMessage, res: ServerResponse): Session {
  const existing = cookieValue(req, sessionCookie);
  let session = existing ? sessions.get(existing) : undefined;
  if (!session) {
    const id = randomUUID();
    session = new Session(mcpUrl, language);
    session.ready.catch(error => console.error('MCP connection failed:', (error as Error).message));
    sessions.set(id, session);
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    res.setHeader('set-cookie', `${sessionCookie}=${id}; Path=/; HttpOnly; SameSite=Lax${secure}`);
  }
  session.lastSeen = Date.now();
  return session;
}

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (session.screens.size === 0 && now - session.lastSeen > idleLimitMs) {
      sessions.delete(id);
      void session.close();
    }
  }
}, 10 * 60 * 1000).unref();

function authorized(req: IncomingMessage, res: ServerResponse): boolean {
  if (!basicAuth) return true;
  const given = Buffer.from(req.headers.authorization ?? '');
  if (given.length === basicAuth.length && timingSafeEqual(given, basicAuth)) return true;
  res.writeHead(401, { 'www-authenticate': 'Basic realm="Alexa+ simulator", charset="UTF-8"' }).end();
  return false;
}

function takeTurnSlot(): boolean {
  const hourAgo = Date.now() - 3_600_000;
  while (recentTurns.length > 0 && recentTurns[0]! < hourAgo) recentTurns.shift();
  if (recentTurns.length >= maxTurnsPerHour) return false;
  recentTurns.push(Date.now());
  return true;
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
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
      return;
    }
    if (!authorized(req, res)) return;
    if (req.method === 'GET' && url.pathname === '/api/events') {
      const session = sessionFor(req, res);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      try {
        await session.ready;
      } catch {
        res.end(`data: ${JSON.stringify({ type: 'error', message: 'The MCP server is not reachable.' })}\n\n`);
        return;
      }
      const tools = session.mcp.tools.map(tool => tool.name);
      res.write(`data: ${JSON.stringify({ type: 'hello', server: session.mcp.serverName, language, tools })}\n\n`);
      session.screens.add(res);
      req.on('close', () => session.screens.delete(res));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/utterance') {
      const session = sessionFor(req, res);
      const { text } = await readJson(req);
      if (typeof text !== 'string' || !text.trim() || text.length > 500) {
        res.writeHead(400).end();
        return;
      }
      if (!takeTurnSlot()) {
        session.caption('say', 'Estoy recibiendo demasiadas preguntas. Intente de nuevo en unos minutos.');
        res.writeHead(429).end();
        return;
      }
      void session.handleUtterance(text.trim());
      res.writeHead(202).end();
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/form') {
      const session = sessionFor(req, res);
      const { id, action, content } = await readJson(req);
      const answer = { action, content } as FormAnswer;
      const ok =
        typeof id === 'string' && ['accept', 'decline', 'cancel'].includes(String(action)) && session.mcp.answerForm(id, answer);
      if (ok) session.broadcast({ type: 'form-closed', id });
      res.writeHead(ok ? 204 : 404).end();
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/reset') {
      sessionFor(req, res).reset();
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

server.listen(port, bindAddress, () => {
  console.log(`Alexa+ simulator on http://${bindAddress}:${port} — MCP server ${mcpUrl.href}`);
});
