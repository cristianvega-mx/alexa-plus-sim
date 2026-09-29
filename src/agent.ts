import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
  type Message,
  type Tool as BedrockTool
} from '@aws-sdk/client-bedrock-runtime';
import type { CallToolResult } from '@modelcontextprotocol/client';
import type { DocumentType } from '@smithy/types';
import type { McpBridge } from './mcp.js';

const bedrock = new BedrockRuntimeClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
const modelId = process.env.SIM_MODEL_ID ?? 'us.amazon.nova-pro-v1:0';
const maxSteps = 8;

export type AgentListener = {
  toolCall(name: string, args: Record<string, unknown>): void;
  toolResult(name: string, args: Record<string, unknown>, result: CallToolResult): void | Promise<void>;
  say(text: string): void;
};

function systemPrompt(language: string, serverName: string, instructions?: string): string {
  const today = new Intl.DateTimeFormat(language, { dateStyle: 'full', timeZone: 'America/Chicago' }).format(new Date());
  return [
    `You are Alexa+ on an Echo Show in a family's kitchen. Always answer in the language of ${language}, using "usted".`,
    'Everything you write is spoken aloud: at most two short sentences, no lists, no markdown, no URLs, no emoji.',
    'The screen shows tool results, so do not read long details that are already on screen;',
    'if a result has a link or an email address, say that it is on the screen instead of reading it.',
    `Use the tools of the connected skill "${serverName}" for anything about the family; never invent facts.`,
    'When a tool result has a "spoken" field, say it almost word for word.',
    'Before a tool that saves something, it will show the person a confirmation form; do not ask again yourself.',
    'After something is saved, say in one sentence what was saved and for whom.',
    `Today is ${today}.`,
    instructions ? `Skill instructions: ${instructions}` : ''
  ].join(' ');
}

// What a speaker can actually say: no <thinking> blocks (Nova models add them before tool calls),
// no markdown, and no links or email addresses, which belong on the screen.
function spokenText(content: ContentBlock[]): string {
  return content
    .map(block => block.text ?? '')
    .join(' ')
    .replace(/<thinking>[\s\S]*?<\/thinking>/g, '')
    .replace(/\[([^\]]*)\]\(([^)]*)\)/g, (_link, label: string) => (/^(https?:|mailto:)/.test(label) ? '' : label))
    .replace(/\b(?:https?:\/\/|mailto:)\S+/g, '')
    .replace(/[*_`#>]/g, '')
    .replace(/\s+([.,;:])/g, '$1')
    .replace(/:\s*\./g, '.')
    .replace(/\s+/g, ' ')
    .trim();
}

// The model gets the tool's own words (plain text blocks) and its structured data.
function toolResultBlock(toolUseId: string, result: CallToolResult): ContentBlock {
  const texts = result.content.flatMap(block => {
    if (block.type === 'resource_link') return [`[resource ${block.uri}]`];
    if (block.type !== 'text') return [];
    return result.structuredContent && block.text.trim().startsWith('{') ? [] : [block.text];
  });
  const content: NonNullable<NonNullable<ContentBlock['toolResult']>['content']> = texts.map(text => ({ text }));
  if (result.structuredContent) content.push({ json: result.structuredContent as DocumentType });
  if (content.length === 0) content.push({ text: '(empty)' });
  return { toolResult: { toolUseId, status: result.isError ? 'error' : 'success', content } };
}

// A Bedrock Converse tool-use loop over the MCP server's tools, keeping the conversation between turns.
export class Agent {
  private messages: Message[] = [];

  constructor(
    private mcp: McpBridge,
    private language: string,
    private listener: AgentListener
  ) {}

  reset(): void {
    this.messages = [];
  }

  private bedrockTools(): BedrockTool[] {
    return this.mcp.tools.map(tool => {
      const { $schema: _dialect, ...schema } = tool.inputSchema as Record<string, unknown>;
      return {
        toolSpec: {
          name: tool.name,
          description: tool.description ?? tool.title ?? tool.name,
          inputSchema: { json: schema as DocumentType }
        }
      };
    });
  }

  async turn(userText: string): Promise<void> {
    this.messages.push({ role: 'user', content: [{ text: userText }] });
    const system = systemPrompt(this.language, this.mcp.serverName, this.mcp.client.getInstructions());

    for (let step = 0; step < maxSteps; step++) {
      const response = await bedrock.send(
        new ConverseCommand({
          modelId,
          system: [{ text: system }],
          messages: this.messages,
          toolConfig: { tools: this.bedrockTools() },
          inferenceConfig: { maxTokens: 800, temperature: 0 }
        })
      );
      const message = response.output?.message;
      if (!message?.content) throw new Error('Bedrock returned no message.');
      this.messages.push(message);

      const toolUses = message.content.flatMap(block => (block.toolUse ? [block.toolUse] : []));
      if (response.stopReason !== 'tool_use' || toolUses.length === 0) {
        const text = spokenText(message.content);
        if (text) this.listener.say(text);
        return;
      }

      const results: ContentBlock[] = [];
      for (const use of toolUses) {
        const args = (use.input ?? {}) as Record<string, unknown>;
        this.listener.toolCall(use.name!, args);
        const result = await this.mcp.callTool(use.name!, args);
        await this.listener.toolResult(use.name!, args, result);
        results.push(toolResultBlock(use.toolUseId!, result));
      }
      this.messages.push({ role: 'user', content: results });
    }
    this.listener.say('Perdón, no pude terminar eso. ¿Me lo repite de otra forma?');
  }
}
