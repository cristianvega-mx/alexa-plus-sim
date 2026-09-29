# alexa-plus-sim

An Echo Show–style **Alexa+ simulator for MCP servers**. Point it at any MCP server that speaks Streamable HTTP and
talk to it the way a family would talk to Alexa+: by voice, in their language, with answers spoken aloud and details on
the screen.

It exists because testing an Alexa+ integration usually means a real device, an account in a supported country and a
deployed skill. This runs on a laptop in one command.

## Features

- **Agent on Amazon Bedrock.** A Converse tool-use loop (Amazon Nova Pro by default) turns what the person says into
  MCP tool calls, keeps the conversation between turns and answers in at most two spoken sentences.
- **Voice in and out.** Chrome's Web Speech API for listening (push-to-talk button or the space bar) and speaking;
  captions show what was heard and what Alexa says, optionally with subtitles in a second language.
- **Elicitation on screen.** When a tool answers with an `input_required` result (MCP protocol 2026-07-28), the form
  appears on the screen: checkboxes, toggles, choices. The person taps *Aceptar* or simply says "sí" or "no".
- **MCP Apps.** Tools that declare `_meta.ui.resourceUri` get their own UI: the simulator fetches the `ui://` resource
  once and renders it in a sandboxed iframe, acting as the host side of the MCP Apps protocol (spec 2026-01-26).
- **Readable fallback cards** for any tool's `structuredContent`: dates become chips, ids are hidden.
- **MCP traffic panel** showing every tool call, result, elicitation round trip and MCP Apps message — useful for demos
  and debugging.
- Never speaks links, email addresses, markdown or the model's `<thinking>` text.

## Run

```bash
cp .env.example .env    # Bedrock API key, model id, MCP server URL, language
npm install
npm start               # http://127.0.0.1:4000 — use Chrome for speech recognition
```

| Variable | Default | Meaning |
|---|---|---|
| `AWS_BEARER_TOKEN_BEDROCK` | — | Amazon Bedrock API key (or use any standard AWS credentials). |
| `AWS_REGION` | `us-east-1` | Bedrock region. |
| `SIM_MODEL_ID` | `us.amazon.nova-pro-v1:0` | Model that plays Alexa+; must support tool use. |
| `MCP_SERVER_URL` | `http://127.0.0.1:3000/mcp` | The MCP server to test. |
| `SIM_LANGUAGE` | `es-MX` | Language Alexa+ listens and speaks in. |
| `SIM_CAPTION_LANGUAGE` | (off) | Adds subtitles in a second language, e.g. `English` for a Spanish demo. |
| `SIM_CAPTION_MODEL_ID` | `global.amazon.nova-2-lite-v1:0` | Model that translates the subtitles. |
| `PORT` | `4000` | Where the simulator is served (bound to 127.0.0.1). |

## How it works

- `src/mcp.ts` — MCP client (`versionNegotiation: 'auto'`, declares form elicitation and the
  `io.modelcontextprotocol/ui` extension). Elicitation requests wait for the answer from the screen.
- `src/agent.ts` — Bedrock Converse loop over the server's tools.
- `src/server.ts` — serves the screen and pushes events to it with Server-Sent Events.
- `public/` — the Echo Show screen: speech, captions, light bar, cards, forms and the MCP Apps host.

It is a local development tool: single user, no authentication, bound to localhost.

## License

MIT — see [LICENSE](LICENSE).
