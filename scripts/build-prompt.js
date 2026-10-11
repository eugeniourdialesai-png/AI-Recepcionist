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

const vars = {
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
const firstMessage = `Gracias por llamar a ${config.display_name}, ¿en qué le puedo ayudar?`;

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, `${restaurantId}.md`), prompt);
fs.writeFileSync(path.join(OUT_DIR, `${restaurantId}.first-message.txt`), firstMessage + "\n");
console.log(`OK: prompts/generated/${restaurantId}.md (${prompt.length} caracteres)`);
console.log(`OK: prompts/generated/${restaurantId}.first-message.txt`);
