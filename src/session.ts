import type { ServerResponse } from 'node:http';
import { Agent } from './agent.js';
import { captionsEnabled, translateCaption } from './captions.js';
import { McpBridge, type FormAnswer } from './mcp.js';

// \b does not work after accented letters ("sí"), so the words end at the first non-letter instead.
const yes = /^(s[ií]|claro|ok|okay|de acuerdo|gu[aá]rd[ae]lo|adelante|yes)(?!\p{L})/iu;
const no = /^(no|cancela|cancelar|mejor no)(?!\p{L})/iu;

// One simulated Echo Show: its own MCP connection, conversation and open screens (browser tabs).
// Everything the screens need arrives as Server-Sent Events.
export class Session {
  readonly screens = new Set<ServerResponse>();
  readonly mcp: McpBridge;
  readonly agent: Agent;
  readonly ready: Promise<void>;
  lastSeen = Date.now();
  private busy = false;
  private captionCount = 0;

  constructor(mcpUrl: URL, readonly language: string) {
    // Forms appear on screen and Alexa reads the first line of the question (the details stay on screen).
    this.mcp = new McpBridge(mcpUrl, form => {
      this.broadcast({ type: 'form', ...form });
      this.caption('say', `${form.message.split('\n')[0]} Puede tocar Aceptar o decir sí.`);
    });
    this.agent = new Agent(this.mcp, language, {
      toolCall: (name, args) => this.broadcast({ type: 'tool-call', name, args }),
      toolResult: async (name, args, result) => {
        const app = result.isError ? undefined : await this.mcp.appFor(name);
        this.broadcast({
          type: 'tool-result',
          name,
          args,
          isError: result.isError === true,
          data: result.structuredContent ?? null,
          result,
          app
        });
      },
      say: text => this.caption('say', text)
    });
    this.ready = this.mcp.connect();
  }

  broadcast(event: Record<string, unknown>): void {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const screen of this.screens) screen.write(data);
  }

  // A caption (what the person said or what Alexa says), followed by its translation when captions are on.
  caption(type: 'user' | 'say', text: string): void {
    const id = ++this.captionCount;
    this.broadcast({ type, id, text });
    if (!captionsEnabled) return;
    translateCaption(text)
      .then(translation => translation && this.broadcast({ type: 'caption-translation', id, of: type, text: translation }))
      .catch(error => console.error('caption translation failed:', (error as Error).message));
  }

  async handleUtterance(text: string): Promise<void> {
    this.caption('user', text);
    // A spoken yes/no answers a form that is on screen, with the choices already selected.
    const openForm = this.mcp.openFormId;
    if (openForm) {
      const answer: FormAnswer | undefined = yes.test(text) ? { action: 'accept' } : no.test(text) ? { action: 'decline' } : undefined;
      if (answer) {
        this.broadcast({ type: 'form-voice-answer', id: openForm, action: answer.action });
        return;
      }
    }
    if (this.busy) {
      this.caption('say', 'Un momento, sigo con lo anterior.');
      return;
    }
    this.busy = true;
    this.broadcast({ type: 'thinking', on: true });
    try {
      await this.ready;
      await this.agent.turn(text);
    } catch (error) {
      console.error(error);
      this.caption('say', 'Perdón, tuve un problema. ¿Me lo repite?');
    } finally {
      this.busy = false;
      this.broadcast({ type: 'thinking', on: false });
    }
  }

  reset(): void {
    this.agent.reset();
    this.broadcast({ type: 'reset' });
  }

  async close(): Promise<void> {
    for (const screen of this.screens) screen.end();
    await this.mcp.client.close().catch(() => undefined);
  }
}
