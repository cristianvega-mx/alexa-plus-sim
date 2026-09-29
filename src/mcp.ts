import { randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport, type CallToolResult, type Tool } from '@modelcontextprotocol/client';

export type FormField = { type?: string; title?: string; description?: string; default?: unknown } & Record<string, unknown>;
export type FormRequest = {
  id: string;
  message: string;
  schema: { type: 'object'; properties: Record<string, FormField>; required?: string[] };
};
export type FormAnswer = { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, string | number | boolean | string[]> };

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
    this.client = new Client(
      { name: 'alexa-plus-sim', version: '0.1.0' },
      { capabilities: { elicitation: { form: {} } }, versionNegotiation: { mode: 'auto' } }
    );
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

  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    try {
      return (await this.client.callTool({ name, arguments: args })) as CallToolResult;
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: `Tool call failed: ${(error as Error).message}` }] };
    }
  }
}
