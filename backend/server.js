// Backend mínimo multi-tenant para el recepcionista de IA.
// No toca audio — eso lo hace ElevenLabs Conversational AI. Este servicio
// solo: (1) valida el pedido que el agente extrajo contra el menú real del
// negocio, (2) lo guarda, (3) lo entrega (WhatsApp/dashboard).
//
// Uso: configura el "tool" submit_order.schema.json en el agente de
// ElevenLabs para que apunte su webhook a POST /webhook/submit-order de
// este servidor, con el header X-Webhook-Secret.
//
// Los mensajes de error son frases completas en español: el agente los lee
// y debe poder corregir el pedido con ellos (o explicárselo al cliente).

import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import { getStatus } from "./hours.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = path.join(__dirname, "..", "config");
const ORDERS_DIR = path.join(__dirname, "orders");
// trim(): un salto de línea o espacio pegado por accidente en Render no debe
// romper la autenticación.
const WEBHOOK_SECRET = (process.env.WEBHOOK_SECRET || "").trim();
const RESTAURANT_ID_PATTERN = /^[a-z0-9-]+$/;
const CHANNELS = ["pickup", "delivery"];

if (!fs.existsSync(ORDERS_DIR)) fs.mkdirSync(ORDERS_DIR, { recursive: true });

if (!WEBHOOK_SECRET) {
  console.warn(
    "\n[ADVERTENCIA] WEBHOOK_SECRET no está definido. El servidor arranca, pero " +
      "/webhook/submit-order y /restaurants/:id/orders van a responder 503 hasta " +
      "que lo configures (Render → Environment).\n"
  );
}

const app = express();
app.use(express.json());

// --- Autenticación: header X-Webhook-Secret contra WEBHOOK_SECRET. ---
// Sin secreto configurado se rechaza todo (fail-closed) en lugar de dejar
// el endpoint abierto a pedidos falsos.
function requireSecret(req, res, next) {
  if (!WEBHOOK_SECRET) {
    return res.status(503).json({
      ok: false,
      error: "El sistema de pedidos no está configurado todavía. Toma el nombre y número del cliente para que el restaurante le devuelva la llamada.",
    });
  }
  const given = Buffer.from((req.get("X-Webhook-Secret") || "").trim());
  const expected = Buffer.from(WEBHOOK_SECRET);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return res.status(401).json({ ok: false, error: "No autorizado." });
  }
  next();
}

// --- Config multi-tenant: un JSON por restaurante, cargado en memoria. ---
// Cambiar por una tabla real (Postgres/SQLite) cuando haya más de un
// puñado de clientes; para v1 y para probar el producto, archivos planos
// alcanzan y son más fáciles de auditar a mano.
function loadRestaurantConfig(restaurantId) {
  if (typeof restaurantId !== "string" || !RESTAURANT_ID_PATTERN.test(restaurantId)) return null;
  const file = path.join(CONFIG_DIR, `${restaurantId}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

// modifiers llega como array de strings (esquema oficial), pero también se
// acepta un string ("sin cebolla, extra salsa") por si el LLM lo manda así.
function normalizeModifiers(modifiers) {
  if (modifiers === undefined || modifiers === null || modifiers === "") return [];
  const list = typeof modifiers === "string" ? modifiers.split(/[,;]/) : modifiers;
  if (!Array.isArray(list) || list.some((m) => typeof m !== "string")) return null;
  return list.map((m) => m.trim()).filter(Boolean);
}

function validMenuList(config) {
  return config.menu.map((m) => `${m.name} (item_id: ${m.item_id})`).join(", ");
}

// Valida y normaliza las líneas del pedido. Devuelve { items, errors }.
function validateOrderAgainstMenu(config, items) {
  const menuById = new Map(config.menu.map((m) => [m.item_id, m]));
  const errors = [];
  const normalized = [];
  for (const line of items) {
    const menuItem = menuById.get(line?.item_id);
    if (!menuItem) {
      errors.push(`El platillo "${line?.item_id}" no existe en el menú.`);
      continue;
    }
    const quantity = Number(line.quantity);
    if (!Number.isInteger(quantity) || quantity < 1) {
      errors.push(`La cantidad de ${menuItem.name} debe ser un número entero mayor a cero (llegó: ${line.quantity}).`);
      continue;
    }
    const modifiers = normalizeModifiers(line.modifiers);
    if (modifiers === null) {
      errors.push(`Las modificaciones de ${menuItem.name} deben ser una lista de textos, por ejemplo ["sin cebolla"].`);
      continue;
    }
    normalized.push({ item_id: menuItem.item_id, name: menuItem.name, quantity, modifiers, unit_price_mxn: menuItem.price_mxn });
  }
  if (errors.some((e) => e.includes("no existe en el menú"))) {
    errors.push(`Platillos válidos: ${validMenuList(config)}.`);
  }
  return { items: normalized, errors };
}

// ?at=<ISO> simula otra hora. Solo lo acepta GET /status (pruebas);
// submit_order siempre usa la hora real.
function requestTime(req) {
  if (!req.query.at) return new Date();
  const date = new Date(req.query.at);
  return Number.isNaN(date.getTime()) ? null : date;
}

function customerLabel(order) {
  return order.customer_name || order.customer_phone || "cliente";
}

// Stub — reemplazar con Twilio WhatsApp API o WhatsApp Business Cloud API.
async function sendWhatsAppNotification(config, order) {
  const lines = [
    `Nuevo pedido ${order.order_id} — ${order.channel === "delivery" ? "A DOMICILIO" : "PARA RECOGER"}`,
    `Cliente: ${customerLabel(order)}`,
    `Teléfono: ${order.customer_phone || "no disponible"}`,
    ...(order.channel === "delivery" ? [`Dirección: ${order.delivery_address}`] : []),
    "",
    ...order.items.map(
      (i) => `${i.quantity}x ${i.name}${i.modifiers.length ? ` (${i.modifiers.join(", ")})` : ""}`
    ),
    "",
    `Total estimado: $${order.total_mxn} MXN`,
    ...(order.notes ? [`Notas: ${order.notes}`] : []),
  ];
  console.log(`[WHATSAPP STUB] -> ${config.delivery_output.whatsapp_number}:\n${lines.join("\n")}`);
}

app.post("/webhook/submit-order", requireSecret, async (req, res) => {
  const order = req.body || {};

  if (order.customer_confirmed !== true) {
    return res.status(400).json({
      ok: false,
      error: "El pedido no se registró porque el cliente no lo ha confirmado. Lee el pedido completo en voz alta, espera a que el cliente diga que sí y vuelve a enviarlo con customer_confirmed = true.",
    });
  }

  const config = loadRestaurantConfig(order.restaurant_id);
  if (!config) {
    return res.status(404).json({
      ok: false,
      error: "No encontré la configuración de este restaurante, así que no puedo registrar el pedido. Toma el nombre y número del cliente y avísale que el restaurante le devolverá la llamada.",
    });
  }

  // Defensa: aunque el agente se equivoque, con el restaurante cerrado no
  // entra ningún pedido. Siempre con la hora real (sin ?at).
  const status = getStatus(config, new Date());
  if (!status.is_open) {
    return res.status(409).json({
      ok: false,
      is_open: false,
      error: `${status.message} No se registró el pedido. Ofrécele al cliente tomar su nombre y número para que el restaurante lo llame cuando abra.`,
    });
  }

  if (!CHANNELS.includes(order.channel)) {
    return res.status(400).json({
      ok: false,
      error: `El tipo de entrega debe ser "pickup" (para recoger) o "delivery" (a domicilio). Pregúntale al cliente cuál prefiere.`,
    });
  }

  if (!config.order_channels?.[order.channel]) {
    const alt = CHANNELS.find((c) => c !== order.channel && config.order_channels?.[c]);
    return res.status(400).json({
      ok: false,
      error:
        `${config.display_name} no ofrece pedidos ${order.channel === "delivery" ? "a domicilio" : "para recoger"}.` +
        (alt ? ` Ofrécele al cliente la opción ${alt === "delivery" ? "a domicilio" : "para recoger"}.` : ""),
    });
  }

  const deliveryAddress = typeof order.delivery_address === "string" ? order.delivery_address.trim() : "";
  if (order.channel === "delivery" && !deliveryAddress) {
    return res.status(400).json({
      ok: false,
      error: "Falta la dirección de entrega. Pídele al cliente su dirección completa (calle, número, colonia) y vuelve a enviar el pedido.",
    });
  }

  if (!Array.isArray(order.items) || order.items.length === 0) {
    return res.status(400).json({
      ok: false,
      error: "El pedido no tiene platillos. Pregúntale al cliente qué quiere ordenar.",
    });
  }

  const { items, errors } = validateOrderAgainstMenu(config, order.items);
  if (errors.length > 0) {
    return res.status(422).json({ ok: false, error: errors.join(" ") });
  }

  const record = {
    order_id: crypto.randomBytes(3).toString("hex").toUpperCase(),
    restaurant_id: config.restaurant_id,
    channel: order.channel,
    customer_name: typeof order.customer_name === "string" ? order.customer_name.trim() : "",
    customer_phone: typeof order.customer_phone === "string" ? order.customer_phone.trim() : "",
    delivery_address: order.channel === "delivery" ? deliveryAddress : "",
    items,
    total_mxn: items.reduce((sum, i) => sum + i.quantity * i.unit_price_mxn, 0),
    notes: typeof order.notes === "string" ? order.notes.trim() : "",
    customer_confirmed: true,
    received_at: new Date().toISOString(),
    status: "new",
  };

  const restaurantOrdersFile = path.join(ORDERS_DIR, `${record.restaurant_id}.jsonl`);
  fs.appendFileSync(restaurantOrdersFile, JSON.stringify(record) + "\n");

  if (config.delivery_output?.type === "whatsapp") {
    await sendWhatsAppNotification(config, record);
  }

  return res.json({
    ok: true,
    order_id: record.order_id,
    total_mxn: record.total_mxn,
    message: `Pedido registrado con el número ${record.order_id}. Total estimado: ${record.total_mxn} pesos.`,
  });
});

// --- Mensajes para devolver la llamada (tool take_message) ---
// Funciona aunque el restaurante esté cerrado: es justo el caso de uso.
const MESSAGE_REASONS = ["cerrado", "no_entendio", "otro"];
const REASON_LABELS = { cerrado: "llamó con el restaurante cerrado", no_entendio: "el agente no le entendió", otro: "otro motivo" };

async function sendCallbackNotification(config, record) {
  const lines = [
    `Llamada pendiente ${record.message_id}`,
    `Cliente: ${record.customer_name || "sin nombre"}`,
    `Teléfono: ${record.customer_phone}`,
    `Motivo: ${REASON_LABELS[record.reason]}`,
    ...(record.message ? [`Mensaje: ${record.message}`] : []),
  ];
  console.log(`[WHATSAPP STUB] -> ${config.delivery_output.whatsapp_number}:\n${lines.join("\n")}`);
}

app.post("/webhook/take-message", requireSecret, async (req, res) => {
  const body = req.body || {};
  const config = loadRestaurantConfig(body.restaurant_id);
  if (!config) {
    return res.status(404).json({
      ok: false,
      error: "No se pudo registrar el mensaje porque no encontré la configuración del restaurante. No le prometas al cliente que le van a llamar; pídele que vuelva a llamar más tarde.",
    });
  }

  const clean = (v) => (typeof v === "string" ? v.trim() : "");
  // customer_phone es el número que dio el cliente; caller_id, el de la
  // llamada. Se usa el que dio el cliente y, si no dio, el de la llamada.
  const phone = clean(body.customer_phone) || clean(body.caller_id);
  if (phone.replace(/\D/g, "").length < 7) {
    return res.status(400).json({
      ok: false,
      error: "Falta un número de teléfono válido para devolver la llamada. Pídele al cliente su número completo, con lada, y vuelve a intentarlo.",
    });
  }
  if (!MESSAGE_REASONS.includes(body.reason)) {
    return res.status(400).json({
      ok: false,
      error: `El motivo debe ser "cerrado", "no_entendio" u "otro". Vuelve a enviarlo con uno de esos valores.`,
    });
  }

  const record = {
    message_id: crypto.randomBytes(3).toString("hex").toUpperCase(),
    restaurant_id: config.restaurant_id,
    customer_name: clean(body.customer_name),
    customer_phone: phone,
    caller_id: clean(body.caller_id),
    reason: body.reason,
    message: clean(body.message),
    received_at: new Date().toISOString(),
    status: "pending",
  };
  fs.appendFileSync(path.join(ORDERS_DIR, `${record.restaurant_id}.messages.jsonl`), JSON.stringify(record) + "\n");

  if (config.delivery_output?.type === "whatsapp") {
    await sendCallbackNotification(config, record);
  }

  return res.json({
    ok: true,
    message_id: record.message_id,
    message: `Mensaje registrado. El restaurante le devolverá la llamada al ${phone}.`,
  });
});

// Mensajes pendientes de un restaurante (dashboard). Protegido: tiene teléfonos.
app.get("/restaurants/:id/messages", requireSecret, (req, res) => {
  if (!RESTAURANT_ID_PATTERN.test(req.params.id)) {
    return res.status(400).json({ ok: false, error: "restaurant_id inválido." });
  }
  const file = path.join(ORDERS_DIR, `${req.params.id}.messages.jsonl`);
  if (!fs.existsSync(file)) return res.json({ messages: [] });
  const lines = fs.readFileSync(file, "utf-8").trim().split("\n").filter(Boolean);
  res.json({ messages: lines.map((l) => JSON.parse(l)).reverse() });
});

// Estado de horario (lo usa la tool check_hours del agente). El agente lee
// "message" tal cual; el resto es contexto en texto natural de 12 horas.
app.get("/restaurants/:id/status", requireSecret, (req, res) => {
  const config = loadRestaurantConfig(req.params.id);
  if (!config) {
    return res.status(404).json({
      ok: false,
      error: "No encontré la configuración de este restaurante. Toma el nombre y número del cliente para que el restaurante le devuelva la llamada.",
    });
  }
  const now = requestTime(req);
  if (!now) return res.status(400).json({ ok: false, error: "El parámetro at no es una fecha válida." });
  res.json({ ok: true, ...getStatus(config, now) });
});

// Endpoint simple para el dashboard: últimos pedidos de un restaurante.
// Protegido con el mismo secreto: contiene teléfonos y direcciones.
app.get("/restaurants/:id/orders", requireSecret, (req, res) => {
  if (!RESTAURANT_ID_PATTERN.test(req.params.id)) {
    return res.status(400).json({ ok: false, error: "restaurant_id inválido." });
  }
  const file = path.join(ORDERS_DIR, `${req.params.id}.jsonl`);
  if (!fs.existsSync(file)) return res.json({ orders: [] });
  const lines = fs.readFileSync(file, "utf-8").trim().split("\n").filter(Boolean);
  const orders = lines.map((l) => JSON.parse(l)).reverse();
  res.json({ orders });
});

app.get("/health", (_req, res) => res.json({ ok: true }));

// JSON mal formado u otros errores: responder JSON legible, no HTML.
app.use((err, _req, res, _next) => {
  console.error(err);
  const status = err.type === "entity.parse.failed" ? 400 : 500;
  res.status(status).json({
    ok: false,
    error:
      status === 400
        ? "Los datos del pedido llegaron mal formados. Vuelve a intentar enviar el pedido."
        : "Hubo un error interno al registrar el pedido. Toma el nombre y número del cliente para que el restaurante le devuelva la llamada.",
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`recepcionista-ia backend escuchando en :${PORT}`));
