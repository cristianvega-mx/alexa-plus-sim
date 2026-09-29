// Screen of the Alexa+ simulator: speech in and out, cards from tool results, forms from elicitation.

const $ = id => document.getElementById(id);
const content = $('content');
const lightBar = $('light-bar');
const log = $('log');
const text = $('text');
const mic = $('mic');

let language = 'es-MX';
let thinking = false;
let speaking = false;
let listening = false;

// ---------- Clock and home screen ----------

function showHome() {
  content.replaceChildren(el('div', { class: 'home' }, [
    el('div', { class: 'home-time', id: 'home-time' }),
    el('div', { class: 'home-date', id: 'home-date' }),
    el('div', { class: 'home-hint' }, 'Toque el micrófono o presione la barra espaciadora para hablar')
  ]));
  tick();
}

function tick() {
  const now = new Date();
  const time = new Intl.DateTimeFormat(language, { hour: 'numeric', minute: '2-digit' }).format(now);
  $('clock').textContent = time;
  const homeTime = $('home-time');
  if (homeTime) {
    homeTime.textContent = time;
    const date = new Intl.DateTimeFormat(language, { weekday: 'long', day: 'numeric', month: 'long' }).format(now);
    $('home-date').textContent = date.charAt(0).toUpperCase() + date.slice(1);
  }
}
setInterval(tick, 10_000);

// ---------- Small DOM helper ----------

function el(tag, attributes = {}, children = []) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined || value === false) continue;
    if (name.startsWith('on')) node.addEventListener(name.slice(2), value);
    else node.setAttribute(name, value === true ? '' : value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

// ---------- Light bar ----------

function updateLight() {
  lightBar.className = 'light-bar' + (listening ? ' listening' : speaking ? ' speaking' : thinking ? ' thinking' : '');
}

// ---------- Speech out ----------

let voice;
function pickVoice() {
  const voices = speechSynthesis.getVoices();
  const base = language.split('-')[0];
  voice =
    voices.find(v => v.lang === language) ??
    voices.find(v => v.lang.replace('_', '-').startsWith(`${base}-`)) ??
    voices.find(v => v.lang.startsWith(base));
}
speechSynthesis.addEventListener('voiceschanged', pickVoice);

function say(words) {
  $('caption-alexa').hidden = false;
  $('caption-alexa').textContent = words;
  const utterance = new SpeechSynthesisUtterance(words);
  utterance.lang = language;
  if (voice) utterance.voice = voice;
  utterance.onstart = () => {
    speaking = true;
    updateLight();
  };
  utterance.onend = utterance.onerror = () => {
    speaking = speechSynthesis.speaking;
    updateLight();
  };
  speechSynthesis.speak(utterance);
}

// ---------- Speech in (Chrome's Web Speech API) ----------

const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
let recognition;

function listen() {
  if (!Recognition) {
    text.focus();
    text.placeholder = 'Este navegador no reconoce voz; escriba aquí.';
    return;
  }
  if (listening) {
    recognition?.stop();
    return;
  }
  speechSynthesis.cancel();
  recognition = new Recognition();
  recognition.lang = language;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;
  let finalText = '';
  recognition.onresult = event => {
    const transcript = Array.from(event.results).map(result => result[0].transcript).join('');
    showUserCaption(transcript);
    if (event.results[event.results.length - 1].isFinal) finalText = transcript;
  };
  recognition.onend = () => {
    listening = false;
    mic.classList.remove('on');
    updateLight();
    if (finalText.trim()) send(finalText);
  };
  recognition.onerror = () => {
    listening = false;
    mic.classList.remove('on');
    updateLight();
  };
  listening = true;
  mic.classList.add('on');
  updateLight();
  recognition.start();
}

function showUserCaption(words) {
  $('caption-user').hidden = false;
  $('caption-user').textContent = `“${words}”`;
}

async function send(words) {
  await fetch('/api/utterance', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: words })
  });
}

// ---------- Cards from tool results ----------

const isoDate = /^\d{4}-\d{2}-\d{2}/;
// Identifiers and bookkeeping fields mean nothing to the person looking at the screen.
const hidden = /^(id|read|uri|mailto|calendarUri)$|Id$|Uri$/;
// In a list, each item shows its most telling fields first.
const leading = ['title', 'subject', 'what', 'term', 'name'];

function sentence(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function formatDate(value) {
  const date = new Date(value.length === 10 ? `${value}T12:00:00Z` : value);
  return el('span', { class: 'chip' }, sentence(new Intl.DateTimeFormat(language, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(date)));
}

function formatValue(value) {
  if (typeof value === 'string' && isoDate.test(value)) return formatDate(value);
  if (typeof value === 'boolean') return value ? '✓' : '✗';
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '—';
    return el('ul', {}, value.map(item => el('li', {}, item && typeof item === 'object' ? compactLine(item) : formatValue(item))));
  }
  if (value && typeof value === 'object') return definitionList(value);
  return value ?? '';
}

// "Día de fotos · Jueves 8 de octubre · Lincoln Elementary"
function compactLine(object) {
  const entries = Object.entries(object).filter(([key, value]) => !hidden.test(key) && value !== null && typeof value !== 'object');
  entries.sort(([a], [b]) => (leading.includes(b) ? 1 : 0) - (leading.includes(a) ? 1 : 0));
  return el('span', {}, entries.slice(0, 4).flatMap(([, value], index) => [index ? ' · ' : '', formatValue(value)]));
}

function prettyKey(key) {
  return sentence(key.replace(/([A-Z])/g, ' $1').toLowerCase());
}

function definitionList(object) {
  const entries = Object.entries(object).filter(([key]) => !hidden.test(key));
  return el('dl', {}, entries.flatMap(([key, value]) => [el('dt', {}, prettyKey(key)), el('dd', {}, formatValue(value))]));
}

// Any tool's structured result becomes a readable card: a headline field first, the rest below.
function showResult(name, data, isError) {
  if (!data) return;
  const fields = { ...data };
  const headline = ['summary', 'subject', 'title', 'message'].find(key => typeof fields[key] === 'string');
  const heading = headline ? fields[headline] : null;
  if (headline) delete fields[headline];
  delete fields.spoken;
  const card = el('article', { class: `card${isError ? ' error' : ''}` }, [
    el('div', { class: 'card-kicker' }, name.replaceAll('_', ' ')),
    heading ? el('h3', {}, heading) : null,
    Object.keys(fields).length ? definitionList(fields) : null
  ]);
  content.replaceChildren(card);
}

// ---------- MCP Apps (spec 2026-01-26): the server's own UI in a sandboxed iframe ----------

const appProtocol = '2026-01-26';
let activeApp = null;

function showApp(event) {
  const frame = el('iframe', { class: 'app-frame', sandbox: 'allow-scripts', title: event.name });
  frame.srcdoc = event.app.html;
  activeApp = { frame, event };
  content.replaceChildren(frame);
  logEntry('call', `↳ render ${event.app.uri}`);
}

window.addEventListener('message', message => {
  if (!activeApp || message.source !== activeApp.frame.contentWindow) return;
  const data = message.data;
  if (!data || data.jsonrpc !== '2.0') return;
  const post = payload => activeApp.frame.contentWindow.postMessage({ jsonrpc: '2.0', ...payload }, '*');
  switch (data.method) {
    case 'ui/initialize':
      post({
        id: data.id,
        result: {
          protocolVersion: appProtocol,
          hostCapabilities: {},
          hostInfo: { name: 'alexa-plus-sim', version: '0.1.0' },
          hostContext: {
            theme: 'dark',
            locale: language,
            displayMode: 'inline',
            availableDisplayModes: ['inline'],
            platform: 'web',
            deviceCapabilities: { touch: true, hover: false }
          }
        }
      });
      logEntry('result', '↔ ui/initialize');
      break;
    case 'ui/notifications/initialized':
      post({ method: 'ui/notifications/tool-input', params: { arguments: activeApp.event.args ?? {} } });
      post({ method: 'ui/notifications/tool-result', params: activeApp.event.result });
      logEntry('call', '→ ui/notifications/tool-result');
      break;
    case 'ui/notifications/size-changed':
      activeApp.frame.style.height = `${Math.ceil(data.params?.height ?? 0)}px`;
      break;
    default:
      if (data.id !== undefined && data.method) {
        post({ id: data.id, error: { code: -32601, message: `${data.method} is not supported by this host` } });
      }
  }
});

// ---------- Forms from MCP elicitation ----------

const openForms = new Map();

function fieldInput(name, field) {
  const options = field.items?.anyOf ?? field.items?.enum?.map(value => ({ const: value, title: value }));
  if (field.type === 'array' && options) {
    const chosen = new Set(field.default ?? []);
    return el('fieldset', {}, [
      el('legend', {}, field.title ?? name),
      ...options.map(option =>
        el('label', { class: 'option' }, [
          el('input', { type: 'checkbox', name, value: option.const, checked: chosen.has(option.const) }),
          option.title
        ])
      )
    ]);
  }
  const single = field.oneOf ?? field.enum?.map(value => ({ const: value, title: value }));
  if (field.type === 'string' && single) {
    return el('fieldset', {}, [
      el('legend', {}, field.title ?? name),
      ...single.map(option =>
        el('label', { class: 'option' }, [
          el('input', { type: 'radio', name, value: option.const, checked: field.default === option.const }),
          option.title
        ])
      )
    ]);
  }
  if (field.type === 'boolean') {
    return el('label', { class: 'option' }, [el('input', { type: 'checkbox', name, 'data-boolean': true, checked: field.default !== false }), field.title ?? name]);
  }
  const type = field.type === 'number' || field.type === 'integer' ? 'number' : 'text';
  return el('fieldset', {}, [el('legend', {}, field.title ?? name), el('input', { type, name, value: field.default ?? '' })]);
}

function readForm(form, schema) {
  const values = {};
  for (const [name, field] of Object.entries(schema.properties ?? {})) {
    const inputs = [...form.querySelectorAll(`[name="${CSS.escape(name)}"]`)];
    if (field.type === 'boolean') values[name] = inputs[0]?.checked ?? false;
    else if (field.type === 'array') values[name] = inputs.filter(input => input.checked).map(input => input.value);
    else if (inputs[0]?.type === 'radio') {
      const picked = inputs.find(input => input.checked);
      if (picked) values[name] = picked.value;
    } else if (inputs[0]?.value !== '') values[name] = field.type === 'number' || field.type === 'integer' ? Number(inputs[0].value) : inputs[0].value;
  }
  return values;
}

async function answerForm(id, action) {
  const open = openForms.get(id);
  if (!open) return;
  openForms.delete(id);
  open.card.classList.add('answered');
  const body = { id, action, content: action === 'accept' ? readForm(open.form, open.schema) : undefined };
  await fetch('/api/form', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

function showForm(request) {
  const form = el('form', {}, [
    el('p', { class: 'message' }, request.message),
    ...Object.entries(request.schema.properties ?? {}).map(([name, field]) => fieldInput(name, field)),
    el('div', { class: 'form-actions' }, [
      el('button', { type: 'submit', class: 'primary' }, 'Aceptar'),
      el('button', { type: 'button', class: 'secondary', onclick: () => answerForm(request.id, 'decline') }, 'Cancelar')
    ])
  ]);
  form.addEventListener('submit', event => {
    event.preventDefault();
    answerForm(request.id, 'accept');
  });
  const card = el('article', { class: 'card form-card' }, [el('div', { class: 'card-kicker' }, 'Confirmación'), form]);
  openForms.set(request.id, { card, form, schema: request.schema });
  content.replaceChildren(card);
  // Read the first line only; the details are on screen.
  say(`${request.message.split('\n')[0]} Puede tocar Aceptar o decir sí.`);
}

// ---------- MCP traffic panel ----------

function logEntry(kind, title, detail) {
  const entry = el('li', { class: kind }, [
    detail === undefined ? el('code', {}, title) : el('details', {}, [el('summary', {}, el('code', {}, title)), el('pre', {}, JSON.stringify(detail, null, 2))])
  ]);
  log.prepend(entry);
}

// ---------- Events from the simulator ----------

const events = new EventSource('/api/events');
events.onmessage = message => {
  const event = JSON.parse(message.data);
  switch (event.type) {
    case 'hello':
      language = event.language;
      document.documentElement.lang = language;
      $('skill').textContent = event.server;
      pickVoice();
      showHome();
      logEntry('result', `connected · ${event.tools.length} tools`, event.tools);
      break;
    case 'user':
      showUserCaption(event.text);
      $('caption-alexa').hidden = true;
      break;
    case 'thinking':
      thinking = event.on;
      updateLight();
      break;
    case 'tool-call':
      logEntry('call', `→ tools/call ${event.name}`, event.args);
      break;
    case 'tool-result':
      logEntry(event.isError ? 'fail' : 'result', `← ${event.name}${event.isError ? ' (error)' : ''}`, event.data);
      if (event.app) showApp(event);
      else showResult(event.name, event.data, event.isError);
      break;
    case 'form':
      logEntry('form', '← input_required · elicitation', { message: event.message, schema: event.schema });
      showForm(event);
      break;
    case 'form-voice-answer':
      answerForm(event.id, event.action);
      break;
    case 'form-closed':
      logEntry('call', '→ retry with inputResponses');
      break;
    case 'say':
      say(event.text);
      break;
    case 'reset':
      $('caption-user').hidden = true;
      $('caption-alexa').hidden = true;
      showHome();
      break;
  }
};

// ---------- Controls ----------

mic.addEventListener('click', listen);
$('console').addEventListener('submit', event => {
  event.preventDefault();
  if (!text.value.trim()) return;
  send(text.value);
  text.value = '';
});
$('reset').addEventListener('click', () => fetch('/api/reset', { method: 'POST' }));
document.addEventListener('keydown', event => {
  if (event.code === 'Space' && document.activeElement === document.body) {
    event.preventDefault();
    listen();
  }
});

showHome();
