# Recepcionista de IA para restaurantes — v1

Producto tipo template/multi-tenant (mismo patrón que el agente CFO): un solo
sistema, cada restaurante trae su propia config, nadie toca el código por
cliente.

## Decisiones de arquitectura (v1)

**Voz: ElevenLabs Conversational AI, no ElevenLabs "clásico".**
El API de TTS de ElevenLabs solo convierte texto a audio — no escucha ni
entiende al que llama. Lo que sí sirve es su producto **Conversational AI
(Agents)**, que ya integra STT + orquestación del LLM + TTS + manejo de
turnos + conexión directa con números de Twilio. Con eso no hay que
construir el pipeline de voz a mano — se configura el agente en su
dashboard/API y se le conecta un número de Twilio por restaurante.

Esto reduce el "backend" real a tres cosas: la config del menú por negocio,
recibir el pedido ya estructurado (vía tool-calling del agente) y
entregarlo (WhatsApp/dashboard). No hay que tocar audio en ningún momento.

**Entrega del pedido (v1): dashboard + WhatsApp, sin integración a POS.**
No existe un POS estándar en México — construir integraciones antes de
tener un cliente que las pida es tiempo quemado sin validar demanda.
"Conectar tu POS" se ofrece como upsell custom, cotizado y construido
cuando un cliente real lo pide y paga por él, no antes.

**Salvaguarda obligatoria: confirmación leída en voz alta.**
El agente SIEMPRE repite el pedido completo (platillos, cantidades,
modificaciones, método de entrega) antes de cerrar la llamada y solo lo
manda al negocio si el cliente confirma. Sin esto, un pedido mal tomado
sale de cocina y cuesta dinero real — es el equivalente a la doble captura
de CLABE en el agente CFO. No es opcional.

**Escalamiento:** si el agente no entiende después de 2 intentos, no
adivina — transfiere a un humano (si hay línea de respaldo) o toma
mensaje/número para que el restaurante regrese la llamada. Nunca inventa
un pedido con baja confianza.

## Riesgo sin validar todavía

Calidad de reconocimiento de voz en español mexicano con ruido de fondo de
cocina/restaurante y acentos regionales — no se puede asumir por los demos
en inglés de ElevenLabs. Antes de vender esto a un cliente real, hay que
probarlo con audio real de un restaurante (llamadas de prueba grabadas en
un ambiente ruidoso).

## Qué falta para correr esto de verdad

- Cuenta de Twilio + número por restaurante (se compra por negocio,
  portable si el negocio quiere quedarse con su número existente vía
  number porting).
- Cuenta de ElevenLabs con Conversational AI habilitado + API key.
- Definir método de envío de WhatsApp (Twilio WhatsApp API o WhatsApp
  Business Cloud API directo — pendiente de decidir, es una elección
  similar a la de POS: empezar simple, mejorar si hay demanda).

## Estructura de este scaffold

```
config/example-restaurant.json      → schema de config por negocio (menú, horarios, FAQs)
prompts/receptionist-system-prompt.md → prompt del agente, con la regla de confirmación obligatoria
backend/tools/submit_order.schema.json → function/tool que el agente llama para entregar el pedido estructurado
backend/server.js                   → recibe el tool-call del agente, valida contra el menú, guarda el pedido, dispara WhatsApp (stub)
backend/package.json
```

Este backend es intencionalmente mínimo — el trabajo pesado de voz lo hace
ElevenLabs. Lo que sí es tuyo y es lo que vendes: la config multi-tenant,
la validación del pedido contra el menú real, y la entrega confiable al
negocio.
