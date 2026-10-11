// Configura un agente de ElevenLabs para un restaurante:
//   0. respaldo del agente y la tool en _archive/
//   1. crea (o actualiza) el secreto del webhook en el workspace
//   2. actualiza la tool submit_order (esquema, header con secreto, timeout)
//      y crea/actualiza la tool check_hours (GET /restaurants/{id}/status)
//   3. actualiza el agente (prompt, first message, LLM, idioma, voz,
//      stability, velocidad, tools asignadas, placeholder de
//      restaurant_id, sonido de fondo). La voz sale de config.voice y el
//      fondo de config.background_sound (preset de ElevenLabs; null = sin fondo).
//   4. vuelve a leer todo y verifica campo por campo
//
// Lee ELEVENLABS_API_KEY y WEBHOOK_SECRET de .env (nunca los imprime).
// Requiere haber corrido antes: node scripts/build-prompt.js <restaurant_id>
//
// Uso:
//   node scripts/elevenlabs-apply.js --agent <id> --tool <id> --restaurant <id> \
//     --llm <llm> [--dry-run]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://api.elevenlabs.io";
const BACKEND_URL = "https://ai-recepcionist-kwao.onrender.com";
const WEBHOOK_URL = `${BACKEND_URL}/webhook/submit-order`;
const STATUS_URL = `${BACKEND_URL}/restaurants/{restaurant_id}/status`;
const SECRET_NAME = "recepcionista_webhook_secret";
const TOOL_TIMEOUT_SECS = 60;

function loadEnv() {
  for (const file of [path.join(ROOT, ".env"), path.join(ROOT, "backend", ".env")]) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

function parseArgs() {
  const args = { dryRun: process.argv.includes("--dry-run") };
  for (const key of ["agent", "tool", "restaurant", "llm"]) {
    const i = process.argv.indexOf(`--${key}`);
    if (i === -1 || !process.argv[i + 1]) {
      console.error(`Falta --${key}`);
      process.exit(1);
    }
    args[key] = process.argv[i + 1];
  }
  return args;
}

async function api(method, urlPath, body) {
  const res = await fetch(API + urlPath, {
    method,
    headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${urlPath} -> ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

// --- Esquema de submit_order (debe coincidir con backend/tools/submit_order.schema.json) ---
const str = (description, extra = {}) => ({ type: "string", description, ...extra });
const fromVar = (type, variable) => ({ type, description: "", dynamic_variable: variable });

function submitOrderToolConfig(secretId) {
  return {
    type: "webhook",
    name: "submit_order",
    description:
      "Entrega un pedido YA CONFIRMADO verbalmente por el cliente al backend del restaurante. Solo se llama después de leer el pedido completo en voz alta y recibir confirmación explícita del cliente.",
    response_timeout_secs: TOOL_TIMEOUT_SECS,
    api_schema: {
      url: WEBHOOK_URL,
      method: "POST",
      content_type: "application/json",
      request_headers: { "X-Webhook-Secret": { secret_id: secretId } },
      request_body_schema: {
        type: "object",
        description:
          "Datos del pedido confirmado verbalmente por el cliente: restaurante, tipo de entrega, datos del cliente, platillos con cantidades y modificaciones, notas, y la confirmación explícita del cliente.",
        required: ["restaurant_id", "channel", "items", "customer_confirmed"],
        properties: {
          restaurant_id: fromVar("string", "restaurant_id"),
          channel: str("Tipo de pedido: pickup (para recoger) o delivery (a domicilio), según lo que indique el cliente.", {
            enum: ["pickup", "delivery"],
          }),
          customer_name: str("Nombre del cliente para el pedido, si lo dio. Si no lo quiere dar, omítelo."),
          customer_phone: fromVar("string", "system__caller_id"),
          delivery_address: str('Dirección de entrega completa (calle, número, colonia). Requerida únicamente si channel es "delivery".'),
          notes: str("Notas adicionales del pedido, si el cliente menciona alguna."),
          customer_confirmed: {
            type: "boolean",
            description: "DEBE ser true. Confirma que el pedido completo fue leído en voz alta y el cliente dijo explícitamente que sí.",
          },
          items: {
            type: "array",
            description: "Lista de platillos que pidió el cliente. Un elemento por cada platillo distinto.",
            items: {
              type: "object",
              description: "Un platillo del pedido.",
              required: ["item_id", "quantity"],
              properties: {
                item_id: str("ID del platillo tal como aparece entre corchetes en el menú. Nunca inventes un ID."),
                quantity: { type: "integer", description: "Cantidad de este platillo, entero mayor a cero. Si no la dice, es 1." },
                modifiers: {
                  type: "array",
                  description: 'Cambios al platillo, uno por elemento, por ejemplo ["sin cebolla", "extra salsa"]. Lista vacía si no hay.',
                  items: { type: "string", description: "Una modificación, por ejemplo \"sin cebolla\"." },
                },
              },
            },
          },
        },
      },
    },
  };
}

// --- check_hours (debe coincidir con backend/tools/check_hours.schema.json) ---
function checkHoursToolConfig(secretId) {
  return {
    type: "webhook",
    name: "check_hours",
    description:
      "Dice si el restaurante está abierto en este momento, a qué hora cierra hoy o cuándo vuelve a abrir. Llámala antes de responder cualquier pregunta sobre si está abierto u horario de hoy, y antes de tomar un pedido. Responde con el campo message tal cual.",
    response_timeout_secs: TOOL_TIMEOUT_SECS,
    api_schema: {
      url: STATUS_URL,
      method: "GET",
      request_headers: { "X-Webhook-Secret": { secret_id: secretId } },
      path_params_schema: { restaurant_id: fromVar("string", "restaurant_id") },
    },
  };
}

function check(results, label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push({ ok, label, actual, expected });
}

loadEnv();
const args = parseArgs();
for (const v of ["ELEVENLABS_API_KEY", "WEBHOOK_SECRET"]) {
  if (!process.env[v]) {
    console.error(`Falta ${v} en .env`);
    process.exit(1);
  }
}

const config = JSON.parse(fs.readFileSync(path.join(ROOT, "config", `${args.restaurant}.json`), "utf-8"));
const voice = config.voice || {};
for (const key of ["voice_id", "tts_model", "stability", "speed", "expressive_mode"]) {
  if (voice[key] === undefined) throw new Error(`Falta voice.${key} en config/${args.restaurant}.json`);
}
const prompt = fs.readFileSync(path.join(ROOT, "prompts", "generated", `${args.restaurant}.md`), "utf-8");
const firstMessage = fs.readFileSync(path.join(ROOT, "prompts", "generated", `${args.restaurant}.first-message.txt`), "utf-8").trim();
if (/\{\{(?!system__)[^}]*\}\}/.test(prompt)) throw new Error("El prompt generado tiene variables sin resolver. Corre build-prompt.js.");

// 0. Respaldo
const [agentBefore, toolBefore] = await Promise.all([
  api("GET", `/v1/convai/agents/${args.agent}`),
  api("GET", `/v1/convai/tools/${args.tool}`),
]);
fs.mkdirSync(path.join(ROOT, "_archive"), { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupFile = path.join(ROOT, "_archive", `elevenlabs-backup-${stamp}.json`);
fs.writeFileSync(backupFile, JSON.stringify({ agent: agentBefore, tool: toolBefore }, null, 2));
console.log(`0. Respaldo: ${path.relative(ROOT, backupFile)}`);

// 1. Secreto
const { secrets } = await api("GET", "/v1/convai/secrets");
let secret = secrets.find((s) => s.name === SECRET_NAME);
if (args.dryRun) {
  console.log(`1. [dry-run] ${secret ? `PATCH secreto existente ${secret.secret_id}` : `POST secreto nuevo "${SECRET_NAME}"`}`);
  secret = secret || { secret_id: "<nuevo>" };
} else if (secret) {
  await api("PATCH", `/v1/convai/secrets/${secret.secret_id}`, { type: "update", name: SECRET_NAME, value: process.env.WEBHOOK_SECRET });
  console.log(`1. Secreto actualizado: ${secret.secret_id}`);
} else {
  secret = await api("POST", "/v1/convai/secrets", { type: "new", name: SECRET_NAME, value: process.env.WEBHOOK_SECRET });
  console.log(`1. Secreto creado: ${secret.secret_id}`);
}

// 2. Tool
const toolConfig = submitOrderToolConfig(secret.secret_id);
if (args.dryRun) {
  console.log(`2. [dry-run] PATCH /v1/convai/tools/${args.tool}\n${JSON.stringify({ tool_config: toolConfig }, null, 2)}`);
} else {
  await api("PATCH", `/v1/convai/tools/${args.tool}`, { tool_config: toolConfig });
  console.log("2. Tool actualizada");
}

// 2b. Tool check_hours: se busca por nombre; si no existe se crea.
const hoursConfig = checkHoursToolConfig(secret.secret_id);
const { tools: found } = await api("GET", "/v1/convai/tools?search=check_hours&types=webhook");
let hoursToolId = found.find((x) => x.tool_config?.name === "check_hours")?.id;
if (args.dryRun) {
  console.log(`2b. [dry-run] ${hoursToolId ? `PATCH /v1/convai/tools/${hoursToolId}` : "POST /v1/convai/tools (nueva)"}\n${JSON.stringify({ tool_config: hoursConfig }, null, 2)}`);
  hoursToolId = hoursToolId || "<nueva>";
} else if (hoursToolId) {
  await api("PATCH", `/v1/convai/tools/${hoursToolId}`, { tool_config: hoursConfig });
  console.log(`2b. Tool check_hours actualizada: ${hoursToolId}`);
} else {
  hoursToolId = (await api("POST", "/v1/convai/tools", { tool_config: hoursConfig })).id;
  console.log(`2b. Tool check_hours creada: ${hoursToolId}`);
}

// 3. Agente: se manda el conversation_config completo con los cambios.
const conversationConfig = structuredClone(agentBefore.conversation_config);
const agentCfg = conversationConfig.agent;
agentCfg.first_message = firstMessage;
agentCfg.language = "es";
agentCfg.dynamic_variables = {
  ...(agentCfg.dynamic_variables || {}),
  dynamic_variable_placeholders: {
    ...(agentCfg.dynamic_variables?.dynamic_variable_placeholders || {}),
    restaurant_id: args.restaurant,
  },
};
agentCfg.prompt.prompt = prompt;
agentCfg.prompt.llm = args.llm;
// Sin timezone: si está puesto, ElevenLabs mete la hora en el prompt y el
// LLM intenta decidir solo si está abierto. Eso lo hace check_hours.
agentCfg.prompt.timezone = null;
agentCfg.prompt.tool_ids = [...new Set([...(agentCfg.prompt.tool_ids || []), args.tool, hoursToolId])];
delete agentCfg.prompt.tools; // deprecado; no se puede mandar junto con tool_ids
conversationConfig.tts.model_id = voice.tts_model;
conversationConfig.tts.voice_id = voice.voice_id;
conversationConfig.tts.stability = voice.stability;
conversationConfig.tts.speed = voice.speed;
conversationConfig.tts.expressive_mode = voice.expressive_mode;
const background = config.background_sound
  ? { source_type: "preset", source_id: config.background_sound.preset, volume: config.background_sound.volume ?? 0.15, crossfade_loop: true }
  : { source_type: null, source_id: null, volume: 0.15, crossfade_loop: true };
conversationConfig.conversation = { ...(conversationConfig.conversation || {}), background_sound: background };

if (args.dryRun) {
  const preview = structuredClone(conversationConfig);
  preview.agent.prompt.prompt = `<${prompt.length} caracteres de prompts/generated/${args.restaurant}.md>`;
  console.log(`3. [dry-run] PATCH /v1/convai/agents/${args.agent} (cambios):`);
  console.log(JSON.stringify({
    first_message: preview.agent.first_message,
    language: preview.agent.language,
    dynamic_variables: preview.agent.dynamic_variables,
    prompt: { prompt: preview.agent.prompt.prompt, llm: preview.agent.prompt.llm, timezone: preview.agent.prompt.timezone ?? null, tool_ids: preview.agent.prompt.tool_ids },
    background_sound: preview.conversation.background_sound,
    tts: { model_id: preview.tts.model_id, voice_id: preview.tts.voice_id, stability: preview.tts.stability, speed: preview.tts.speed, expressive_mode: preview.tts.expressive_mode },
  }, null, 2));
  process.exit(0);
}

await api("PATCH", `/v1/convai/agents/${args.agent}`, { conversation_config: conversationConfig });
console.log("3. Agente actualizado");

// 4. Verificación
const [agentAfter, toolAfter, hoursAfter] = await Promise.all([
  api("GET", `/v1/convai/agents/${args.agent}`),
  api("GET", `/v1/convai/tools/${args.tool}`),
  api("GET", `/v1/convai/tools/${hoursToolId}`),
]);
const a = agentAfter.conversation_config;
const t = toolAfter.tool_config;
const body = t.api_schema?.request_body_schema || {};
const item = body.properties?.items?.items || {};
const results = [];

check(results, "agente.prompt.prompt", a.agent.prompt.prompt, prompt);
check(results, "agente.first_message", a.agent.first_message, firstMessage);
check(results, "agente.language", a.agent.language, "es");
check(results, "agente.prompt.llm", a.agent.prompt.llm, args.llm);
check(results, "agente.prompt.timezone (vacío)", a.agent.prompt.timezone ?? null, null);
check(results, "agente.prompt.tool_ids incluye submit_order", (a.agent.prompt.tool_ids || []).includes(args.tool), true);
check(results, "agente.prompt.tool_ids incluye check_hours", (a.agent.prompt.tool_ids || []).includes(hoursToolId), true);
check(results, "agente.dynamic_variable_placeholders.restaurant_id", a.agent.dynamic_variables?.dynamic_variable_placeholders?.restaurant_id, args.restaurant);
check(results, "agente.tts.model_id", a.tts.model_id, voice.tts_model);
check(results, "agente.tts.voice_id", a.tts.voice_id, voice.voice_id);
check(results, "agente.tts.stability", a.tts.stability, voice.stability);
check(results, "agente.tts.speed", a.tts.speed, voice.speed);
check(results, "agente.tts.expressive_mode", a.tts.expressive_mode, voice.expressive_mode);
check(results, "agente.conversation.background_sound", a.conversation?.background_sound, background);
const { background_sound: _b1, ...convAfter } = a.conversation || {};
const { background_sound: _b2, ...convBefore } = agentBefore.conversation_config.conversation || {};
check(results, "agente: ASR/turnos/conversación sin otros cambios", [a.asr, a.turn, convAfter], [agentBefore.conversation_config.asr, agentBefore.conversation_config.turn, convBefore]);
check(results, "tool.url", t.api_schema.url, WEBHOOK_URL);
check(results, "tool.method", t.api_schema.method, "POST");
check(results, "tool.header X-Webhook-Secret -> secret_id", t.api_schema.request_headers?.["X-Webhook-Secret"]?.secret_id, secret.secret_id);
check(results, "tool.response_timeout_secs", t.response_timeout_secs, TOOL_TIMEOUT_SECS);
check(results, "tool.required", [...(body.required || [])].sort(), ["channel", "customer_confirmed", "items", "restaurant_id"]);
check(results, "tool.restaurant_id <- {{restaurant_id}}", body.properties?.restaurant_id?.dynamic_variable, "restaurant_id");
check(results, "tool.customer_phone <- {{system__caller_id}}", body.properties?.customer_phone?.dynamic_variable, "system__caller_id");
check(results, "tool.channel.enum", body.properties?.channel?.enum, ["pickup", "delivery"]);
check(results, "tool.customer_confirmed.type", body.properties?.customer_confirmed?.type, "boolean");
check(results, "tool.items[].required", [...(item.required || [])].sort(), ["item_id", "quantity"]);
check(results, "tool.items[].quantity.type", item.properties?.quantity?.type, "integer");
check(results, "tool.items[].modifiers", [item.properties?.modifiers?.type, item.properties?.modifiers?.items?.type], ["array", "string"]);

const h = hoursAfter.tool_config;
check(results, "check_hours.url", h.api_schema?.url, STATUS_URL);
check(results, "check_hours.method", h.api_schema?.method, "GET");
check(results, "check_hours.header X-Webhook-Secret -> secret_id", h.api_schema?.request_headers?.["X-Webhook-Secret"]?.secret_id, secret.secret_id);
check(results, "check_hours.restaurant_id <- {{restaurant_id}}", h.api_schema?.path_params_schema?.restaurant_id?.dynamic_variable, "restaurant_id");
check(results, "check_hours.response_timeout_secs", h.response_timeout_secs, TOOL_TIMEOUT_SECS);

console.log("\n4. Verificación:");
for (const r of results) {
  const detail = r.ok ? "" : `  -> esperado ${JSON.stringify(r.expected)}, quedó ${JSON.stringify(r.actual)}`.slice(0, 300);
  console.log(`   ${r.ok ? "OK   " : "FALLA"} ${r.label}${detail}`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} campo(s) no coinciden.` : `\nTodo aplicado (${results.length} campos verificados).`);
process.exit(failed ? 1 : 0);
