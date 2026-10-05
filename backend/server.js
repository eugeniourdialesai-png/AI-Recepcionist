// Backend mínimo multi-tenant para el recepcionista de IA.
// No toca audio — eso lo hace ElevenLabs Conversational AI. Este servicio
// solo: (1) valida el pedido que el agente extrajo contra el menú real del
// negocio, (2) lo guarda, (3) lo entrega (WhatsApp/dashboard).
//
// Uso: configura el "tool" submit_order.schema.json en el agente de
// ElevenLabs para que apunte su webhook a POST /webhook/submit-order de
// este servidor.

import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = path.join(__dirname, "..", "config");
const ORDERS_DIR = path.join(__dirname, "orders");

if (!fs.existsSync(ORDERS_DIR)) fs.mkdirSync(ORDERS_DIR, { recursive: true });

const app = express();
app.use(express.json());

// --- Config multi-tenant: un JSON por restaurante, cargado en memoria. ---
// Cambiar por una tabla real (Postgres/SQLite) cuando haya más de un
// puñado de clientes; para v1 y para probar el producto, archivos planos
// alcanzan y son más fáciles de auditar a mano.
function loadRestaurantConfig(restaurantId) {
  const file = path.join(CONFIG_DIR, `${restaurantId}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

function validateOrderAgainstMenu(config, items) {
  const menuById = new Map(config.menu.map((m) => [m.item_id, m]));
  const errors = [];
  for (const line of items) {
    const menuItem = menuById.get(line.item_id);
    if (!menuItem) {
      errors.push(`item_id desconocido: ${line.item_id}`);
      continue;
    }
    if (!Number.isInteger(line.quantity) || line.quantity < 1) {
      errors.push(`cantidad inválida para ${line.item_id}: ${line.quantity}`);
    }
  }
  return errors;
}

// Stub — reemplazar con Twilio WhatsApp API o WhatsApp Business Cloud API.
async function sendWhatsAppNotification(config, order) {
  console.log(
    `[WHATSAPP STUB] -> ${config.delivery_output.whatsapp_number}: ` +
      `Nuevo pedido de ${order.customer_name || "cliente"} (${order.channel}): ` +
      order.items.map((i) => `${i.quantity}x ${i.item_id}`).join(", ")
  );
}

app.post("/webhook/submit-order", async (req, res) => {
  const order = req.body;

  if (!order.customer_confirmed) {
    return res
      .status(400)
      .json({ ok: false, error: "customer_confirmed debe ser true. El pedido no fue leído/confirmado." });
  }

  const config = loadRestaurantConfig(order.restaurant_id);
  if (!config) {
    return res.status(404).json({ ok: false, error: `restaurant_id no configurado: ${order.restaurant_id}` });
  }

  if (order.channel === "delivery" && !order.delivery_address) {
    return res.status(400).json({ ok: false, error: "delivery_address requerido para channel=delivery" });
  }

  const menuErrors = validateOrderAgainstMenu(config, order.items || []);
  if (menuErrors.length > 0) {
    return res.status(422).json({ ok: false, error: "Pedido no coincide con el menú", details: menuErrors });
  }

  const record = {
    ...order,
    received_at: new Date().toISOString(),
    status: "new",
  };

  const restaurantOrdersFile = path.join(ORDERS_DIR, `${order.restaurant_id}.jsonl`);
  fs.appendFileSync(restaurantOrdersFile, JSON.stringify(record) + "\n");

  if (config.delivery_output?.type === "whatsapp") {
    await sendWhatsAppNotification(config, order);
  }

  return res.json({ ok: true });
});

// Endpoint simple para el dashboard: últimos pedidos de un restaurante.
app.get("/restaurants/:id/orders", (req, res) => {
  const file = path.join(ORDERS_DIR, `${req.params.id}.jsonl`);
  if (!fs.existsSync(file)) return res.json({ orders: [] });
  const lines = fs.readFileSync(file, "utf-8").trim().split("\n").filter(Boolean);
  const orders = lines.map((l) => JSON.parse(l)).reverse();
  res.json({ orders });
});

app.get("/health", (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`recepcionista-ia backend escuchando en :${PORT}`));
