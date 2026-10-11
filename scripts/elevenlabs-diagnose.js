// Diagnóstico de solo lectura del agente de ElevenLabs.
// Lee ELEVENLABS_API_KEY de .env (nunca la imprime), guarda un respaldo
// completo en _archive/elevenlabs-backup-<fecha>.json e imprime un resumen.
//
// Uso:
//   node scripts/elevenlabs-diagnose.js            -> lista los agentes del workspace
//   node scripts/elevenlabs-diagnose.js <agent_id> -> respaldo + diagnóstico

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://api.elevenlabs.io";

function loadEnv() {
  for (const file of [path.join(ROOT, ".env"), path.join(ROOT, "backend", ".env")]) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

async function get(urlPath) {
  const res = await fetch(API + urlPath, { headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY } });
  if (!res.ok) throw new Error(`GET ${urlPath} -> ${res.status}: ${await res.text()}`);
  return res.json();
}

async function listAllTools() {
  const tools = [];
  let cursor = null;
  do {
    const qs = new URLSearchParams({ page_size: "100", ...(cursor ? { cursor } : {}) });
    const page = await get(`/v1/convai/tools?${qs}`);
    tools.push(...page.tools);
    cursor = page.has_more ? page.next_cursor : null;
  } while (cursor);
  return tools;
}

loadEnv();
if (!process.env.ELEVENLABS_API_KEY) {
  console.error("Falta ELEVENLABS_API_KEY en .env (raíz del repo).");
  process.exit(1);
}

const agentId = process.argv[2];

if (!agentId) {
  const { agents } = await get("/v1/convai/agents?page_size=100");
  console.log("Agentes en el workspace:");
  for (const a of agents) console.log(`  ${a.agent_id}  ${a.name}`);
  process.exit(0);
}

const [agent, tools] = await Promise.all([get(`/v1/convai/agents/${agentId}`), listAllTools()]);

const archiveDir = path.join(ROOT, "_archive");
fs.mkdirSync(archiveDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupFile = path.join(archiveDir, `elevenlabs-backup-${stamp}.json`);
fs.writeFileSync(backupFile, JSON.stringify({ agent, tools }, null, 2));

const promptCfg = agent.conversation_config?.agent?.prompt ?? {};
const toolIds = promptCfg.tool_ids ?? [];
const submit = tools.find((t) => t.tool_config?.name === "submit_order");

console.log(`Respaldo guardado en ${path.relative(ROOT, backupFile)}\n`);
console.log(`Agente: ${agent.name} (${agentId})`);
console.log(`LLM: ${promptCfg.llm ?? "?"}`);
console.log(`tool_ids asignados: ${JSON.stringify(toolIds)}`);
console.log(`tools (deprecado) inline: ${(promptCfg.tools ?? []).map((t) => t.name).join(", ") || "ninguno"}`);
console.log(`dynamic_variables: ${JSON.stringify(agent.conversation_config?.agent?.dynamic_variables ?? null, null, 2)}`);
console.log(`first_message: ${agent.conversation_config?.agent?.first_message ?? ""}`);
console.log(`\nsubmit_order existe: ${submit ? `sí (id ${submit.id})` : "NO"}`);
if (submit) {
  console.log(`submit_order asignada al agente: ${toolIds.includes(submit.id) ? "sí" : "NO"}`);
  const { api_schema, ...rest } = submit.tool_config;
  const headers = Object.fromEntries(
    Object.entries(api_schema?.request_headers ?? {}).map(([k]) => [k, "<oculto>"])
  );
  console.log(`url: ${api_schema?.method} ${api_schema?.url}`);
  console.log(`headers: ${JSON.stringify(headers)}`);
  console.log(`timeout: ${rest.response_timeout_secs ?? "default"}`);
  console.log(`request_body_schema:\n${JSON.stringify(api_schema?.request_body_schema, null, 2)}`);
}
console.log(`\nPrompt actual (${(promptCfg.prompt ?? "").length} caracteres):\n${promptCfg.prompt ?? ""}`);
const unresolved = [...new Set((promptCfg.prompt ?? "").match(/\{\{[^}]+\}\}/g) ?? [])];
console.log(`\nVariables {{...}} en el prompt: ${unresolved.join(", ") || "ninguna"}`);
