# alexa-plus-sim

An Echo Show–style **Alexa+ simulator for MCP servers**. Point it at any MCP server that speaks Streamable HTTP and
talk to it the way a family would talk to Alexa+: by voice, in their language, with answers spoken aloud and details on
the screen.

It exists because testing an Alexa+ integration usually means a real device, an account in a supported country and a
deployed skill. This runs on a laptop in one command.

It was built alongside [Puente](https://github.com/cristianvega-mx/puente), an MCP server that explains school notices
to Spanish-speaking parents; the [Puente demo video](https://youtu.be/kg4YrGWWAJk) was recorded in this simulator.

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
| `SIM_TODAY` | (real date) | `YYYY-MM-DD` date Alexa+ assumes, for demos whose sample data lives on fixed dates. |
| `PORT` | `4000` | Where the simulator is served. |
| `SIM_BIND` | `127.0.0.1` | Address to listen on; the Docker image uses `0.0.0.0`. |
| `SIM_BASIC_AUTH` | (off) | `user:password` that every visitor must enter, for a public deployment. |
| `SIM_MAX_TURNS_PER_HOUR` | `300` | Cap on requests that reach the model per hour, across all visitors. |

## Deploy

The `Dockerfile` runs the simulator on port 4000. Each browser gets its own session (its own MCP connection and
conversation, cleaned up after an hour without a screen open), so one deployment can serve several reviewers at once.
Put it behind HTTPS, set `SIM_BASIC_AUTH`, and keep `SIM_MAX_TURNS_PER_HOUR` low enough for your Bedrock budget;
`/healthz` answers without authentication for health checks.

## How it works

- `src/mcp.ts` — MCP client (`versionNegotiation: 'auto'`, declares form elicitation and the
  `io.modelcontextprotocol/ui` extension). Elicitation requests wait for the answer from the screen.
- `src/agent.ts` — Bedrock Converse loop over the server's tools. Tool results reach the model as one JSON block
  (`structuredContent`) or one text block, never both: with mixed blocks, Nova Pro ended turns without a word and
  later wrote tool calls as plain text. If the model still says nothing, the tool's own `spoken` field is used.
- `src/session.ts` — one simulated device per browser: its MCP connection, conversation and open forms.
- `src/server.ts` — serves the screen and pushes events to it with Server-Sent Events.
- `public/` — the Echo Show screen: speech, captions, light bar, cards, forms and the MCP Apps host.

By default it listens on localhost only, with no password: a development tool. See Deploy to share it.

## License

MIT — see [LICENSE](LICENSE).
