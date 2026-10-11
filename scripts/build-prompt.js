// Genera el system prompt y el first message de un restaurante a partir de
// prompts/receptionist-system-prompt.md + config/<restaurant_id>.json.
//
// Uso: node scripts/build-prompt.js <restaurant_id>
// Salida: prompts/generated/<restaurant_id>.md
//         prompts/generated/<restaurant_id>.first-message.txt
//
// Falla si queda cualquier {{...}} sin resolver. Las únicas excepciones son
// las variables de sistema de ElevenLabs ({{system__...}}), que el agente
// llena en cada llamada.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = path.join(ROOT, "prompts", "receptionist-system-prompt.md");
const OUT_DIR = path.join(ROOT, "prompts", "generated");
const RUNTIME_VARIABLE = /^system__[a-z_]+$/;

const DAYS = { mon: "lunes", tue: "martes", wed: "miércoles", thu: "jueves", fri: "viernes", sat: "sábado", sun: "domingo" };
const DAY_ORDER = Object.keys(DAYS);

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function formatMenu(menu) {
  if (!Array.isArray(menu) || menu.length === 0) fail("el config no tiene menú.");
  return menu
    .map((item) => {
      for (const key of ["item_id", "name", "price_mxn", "unit"]) {
        if (item[key] === undefined || item[key] === "") fail(`al platillo ${item.item_id || item.name} le falta "${key}".`);
      }
      const modifiers = (item.modifiers || []).map((m) => (m.default ? `${m.name} (incluido por defecto)` : m.name));
      const allergens = item.allergens || [];
      return [
        `- ${item.name} [${item.item_id}] — $${item.price_mxn} MXN (${item.unit}).`,
        `  Modificaciones: ${modifiers.length ? modifiers.join(", ") : "ninguna"}.`,
        `  Alérgenos: ${allergens.length ? allergens.join(", ") : "ninguno declarado"}.`,
      ].join("\n");
    })
    .join("\n");
}

// "mon-thu" -> "lunes a jueves", "fri-sat" -> "viernes y sábado", "sun" -> "domingo".
function formatDayRange(key) {
  const [from, to] = key.split("-");
  if (!DAYS[from] || (to && !DAYS[to])) fail(`día no reconocido en hours: "${key}". Usa mon, tue, wed, thu, fri, sat, sun.`);
  if (!to) return DAYS[from];
  const adjacent = DAY_ORDER.indexOf(to) - DAY_ORDER.indexOf(from) === 1;
  return `${DAYS[from]} ${adjacent ? "y" : "a"} ${DAYS[to]}`;
}

function formatHours(hours) {
  if (!hours || Object.keys(hours).length === 0) fail("el config no tiene horario.");
  return Object.entries(hours)
    .map(([days, range]) => {
      const [open, close] = String(range).split("-");
      if (!open || !close) fail(`horario inválido para "${days}": "${range}". Usa "HH:MM-HH:MM".`);
      return `- ${formatDayRange(days)}: de ${open} a ${close}`;
    })
    .join("\n");
}

function formatFaqs(faqs) {
  if (!faqs?.length) return "No hay preguntas frecuentes registradas. Si no sabes algo, dilo y ofrece que el restaurante le regrese la llamada.";
  return faqs.map((f) => `- P: ${f.q}\n  R: ${f.a}`).join("\n");
}

function formatChannels(channels = {}) {
  const options = [];
  if (channels.pickup) options.push("para recoger");
  if (channels.delivery) {
    options.push(`a domicilio${channels.delivery_radius_km ? ` (solo dentro de ${channels.delivery_radius_km} km)` : ""}`);
  }
  if (options.length === 0) fail("order_channels no tiene ni pickup ni delivery habilitado.");
  return options.join(" o ");
}

// ElevenLabs convierte la hora con prompt.timezone; aquí solo se valida
// que sea un nombre IANA válido antes de mandarlo.
function validateTimezone(timeZone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
  } catch {
    fail(`timezone inválido: "${timeZone}". Usa un nombre IANA, por ejemplo "America/Monterrey".`);
  }
}

// --- Tono: config.tone = "formal" (default) | "casual" ---
const TONES = {
  formal: {
    style: [
      'Hablas de "usted". Tu tono es profesional y cálido, como un buen recepcionista de restaurante: amable, atento y seguro.',
    ],
    confirmations: ["claro", "muy bien", "enseguida", "perfecto", "con gusto"],
    wait: '"permítame un momento", "enseguida lo registro"',
    greeting: (name) => `Gracias por llamar a ${name}, ¿en qué le puedo ayudar?`,
  },
  casual: {
    style: [
      'Hablas de "tú". Tu tono es cercano y cálido, como alguien del equipo del restaurante que atiende con gusto, pero siempre educado.',
    ],
    confirmations: ["claro", "va", "perfecto", "listo", "con gusto"],
    wait: '"dame un momento", "ahorita lo registro"',
    greeting: (name) => `Gracias por llamar a ${name}, ¿en qué te puedo ayudar?`,
  },
};

const COMMON_STYLE = [
  "Frases cortas. Una sola idea o una sola pregunta por turno; espera la respuesta antes de seguir.",
  "Sin muletillas ni relleno: nunca digas \"este\", \"eh\", \"órale\", \"pues\" ni \"o sea\", y no empieces tus frases con \"bueno\".",
  "Sin frases de call center: nada de \"su llamada es muy importante\", \"le informo que\", \"estimado cliente\", \"con todo gusto le atiendo\" ni \"¿hay algo más en lo que le pueda ayudar?\" después de cada respuesta.",
];

// Etiquetas de emoción: solo los modelos v3 las interpretan. Con cualquier
// otro modelo el agente las leería en voz alta, así que no se incluyen.
function supportsAudioTags(ttsModel) {
  return /^eleven_v3/.test(ttsModel || "");
}

function formatStyle(tone, ttsModel) {
  const confirmations = tone.confirmations.map((c) => `"${c}"`).join(", ");
  const lines = [
    ...tone.style,
    ...COMMON_STYLE,
    `Para confirmar, varía: ${confirmations}. No repitas la misma confirmación dos veces seguidas en la llamada.`,
  ];
  if (supportsAudioTags(ttsModel)) {
    lines.push(
      "Etiquetas de emoción: usa [warmly] solo al saludar y al despedirte, y nada más. No uses ninguna otra etiqueta ni en ningún otro momento."
    );
  } else {
    lines.push("No uses etiquetas entre corchetes como [warmly] en lo que dices: se leerían en voz alta.");
  }
  return lines.map((l) => `- ${l}`).join("\n");
}

function lookup(vars, dottedPath) {
  return dottedPath.split(".").reduce((obj, key) => (obj == null ? undefined : obj[key]), vars);
}

function render(template, vars) {
  // Condicionales (sin anidar): {{#if a.b}} ... {{else}} ... {{/if}}
  let out = template.replace(
    /\{\{#if\s+([\w.]+)\s*\}\}([\s\S]*?)(?:\{\{else\}\}([\s\S]*?))?\{\{\/if\}\}/g,
    (_m, cond, yes, no = "") => (lookup(vars, cond) ? yes : no)
  );
  // Variables simples y con punto. Las de sistema se dejan para ElevenLabs.
  out = out.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, name) => {
    if (RUNTIME_VARIABLE.test(name)) return match;
    const value = lookup(vars, name);
    return value === undefined || value === null || typeof value === "object" ? match : String(value);
  });
  return out;
}

const restaurantId = process.argv[2];
if (!restaurantId || !/^[a-z0-9-]+$/.test(restaurantId)) fail("uso: node scripts/build-prompt.js <restaurant_id>");

const configFile = path.join(ROOT, "config", `${restaurantId}.json`);
if (!fs.existsSync(configFile)) fail(`no existe ${path.relative(ROOT, configFile)}`);
const config = JSON.parse(fs.readFileSync(configFile, "utf-8"));
if (config.restaurant_id !== restaurantId) fail(`restaurant_id del config ("${config.restaurant_id}") no coincide con el nombre del archivo.`);

const rawTemplate = fs.readFileSync(TEMPLATE, "utf-8");
const separator = rawTemplate.indexOf("\n---\n");
if (separator === -1) fail("la plantilla no tiene la línea --- que separa el encabezado del prompt.");
const template = rawTemplate.slice(separator + 5).trim();

validateTimezone(config.timezone);

const toneName = config.tone ?? "formal";
const tone = TONES[toneName];
if (!tone) fail(`tone inválido: "${toneName}". Opciones: ${Object.keys(TONES).join(", ")}.`);
const ttsModel = config.voice?.tts_model;

const vars = {
  style_formatted: formatStyle(tone, ttsModel),
  wait_phrases: tone.wait,
  ...config,
  menu_formatted: formatMenu(config.menu),
  hours_formatted: formatHours(config.hours),
  faqs_formatted: formatFaqs(config.faqs),
  channels_formatted: formatChannels(config.order_channels),
};

const prompt = render(template, vars) + "\n";
const unresolved = [...new Set(prompt.match(/\{\{[^}]*\}\}/g) || [])].filter(
  (v) => !RUNTIME_VARIABLE.test(v.slice(2, -2).trim())
);
if (unresolved.length) fail(`quedaron variables sin resolver: ${unresolved.join(", ")}`);

if (!config.display_name) fail("el config no tiene display_name.");
// Sin etiquetas: la doc de ElevenLabs no confirma que se interpreten en el
// first_message (solo en las respuestas del LLM).
const firstMessage = tone.greeting(config.display_name);

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, `${restaurantId}.md`), prompt);
fs.writeFileSync(path.join(OUT_DIR, `${restaurantId}.first-message.txt`), firstMessage + "\n");
console.log(`OK: prompts/generated/${restaurantId}.md (${prompt.length} caracteres)`);
console.log(`OK: prompts/generated/${restaurantId}.first-message.txt`);
