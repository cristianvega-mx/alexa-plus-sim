import { randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport, type CallToolResult, type Tool } from '@modelcontextprotocol/client';

export type FormField = { type?: string; title?: string; description?: string; default?: unknown } & Record<string, unknown>;
export type FormRequest = {
  id: string;
  message: string;
  schema: { type: 'object'; properties: Record<string, FormField>; required?: string[] };
};
export type FormAnswer = { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, string | number | boolean | string[]> };

const appMimeType = 'text/html;profile=mcp-app';

// Connects to one MCP server as an Alexa+ host would. Elicitation requests from the server are
// handed to `showForm` (the screen) and the call waits until the person answers.
export class McpBridge {
  readonly client: Client;
  tools: Tool[] = [];
  private pending = new Map<string, (answer: FormAnswer) => void>();

  constructor(
    private url: URL,
    private showForm: (form: FormRequest) => void
  ) {
    // Declares MCP Apps support (extension io.modelcontextprotocol/ui) next to form elicitation.
    const capabilities = {
      elicitation: { form: {} },
      extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: [appMimeType] } }
    };
    this.client = new Client({ name: 'alexa-plus-sim', version: '0.1.0' }, { capabilities, versionNegotiation: { mode: 'auto' } });
    this.client.setRequestHandler('elicitation/create', async request => {
      const params = request.params as { message: string; requestedSchema?: FormRequest['schema'] };
      const form: FormRequest = {
        id: randomUUID(),
        message: params.message,
        schema: params.requestedSchema ?? { type: 'object', properties: {} }
      };
      const answer = new Promise<FormAnswer>(resolve => this.pending.set(form.id, resolve));
      this.showForm(form);
      return answer;
    });
  }

  async connect(): Promise<void> {
    await this.client.connect(new StreamableHTTPClientTransport(this.url));
    this.tools = (await this.client.listTools()).tools;
  }

  get serverName(): string {
    const info = this.client.getServerVersion();
    return info?.title ?? info?.name ?? 'MCP server';
  }

  answerForm(id: string, answer: FormAnswer): boolean {
    const resolve = this.pending.get(id);
    if (!resolve) return false;
    this.pending.delete(id);
    resolve(answer);
    return true;
  }

  // The oldest form still waiting, so a spoken "sí" or "no" can answer it.
  get openFormId(): string | undefined {
    return this.pending.keys().next().value;
  }

  private appHtml = new Map<string, Promise<string | undefined>>();

  // The MCP App a tool declares in _meta.ui.resourceUri, fetched once per URI.
  appFor(toolName: string): Promise<{ uri: string; html: string } | undefined> {
    const tool = this.tools.find(candidate => candidate.name === toolName);
    const uri = (tool?._meta?.ui as { resourceUri?: unknown } | undefined)?.resourceUri;
    if (typeof uri !== 'string' || !uri.startsWith('ui://')) return Promise.resolve(undefined);
    let html = this.appHtml.get(uri);
    if (!html) {
      html = this.client
        .readResource({ uri })
        .then(result => {
          const content = result.contents.find(item => item.mimeType === appMimeType && 'text' in item);
          return content && 'text' in content ? content.text : undefined;
        })
        .catch(() => undefined);
      this.appHtml.set(uri, html);
    }
    return html.then(text => (text ? { uri, html: text } : undefined));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    try {
      return (await this.client.callTool({ name, arguments: args })) as CallToolResult;
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: `Tool call failed: ${(error as Error).message}` }] };
    }
  }
}
