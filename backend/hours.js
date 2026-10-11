// Horarios: si el restaurante está abierto se calcula aquí, con código, a
// partir de hours + timezone del config. El LLM nunca decide esto (se
// equivocaba con la hora: a la 1:02 am decía que estaba abierto).
//
// Formato de config.hours:
//   { "mon-thu": "12:00-22:00", "fri-sat": "12:00-23:30", "sun": "13:00-21:00" }
//   - llave: un día ("sun") o un rango ("mon-thu", también "fri-mon")
//   - valor: "HH:MM-HH:MM", varios separados por coma ("13:00-16:00,19:00-23:00"),
//     o "closed". Si cierra después de medianoche: "18:00-02:00".
//
// Todo el texto sale en formato natural de 12 horas ("la una de la tarde"),
// nunca "trece horas".

export const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
export const DAY_NAMES = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"];
const MINUTES_PER_DAY = 24 * 60;

const NUMBERS = [
  "", "uno", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve", "diez",
  "once", "doce", "trece", "catorce", "quince", "dieciséis", "diecisiete", "dieciocho", "diecinueve", "veinte",
  "veintiuno", "veintidós", "veintitrés", "veinticuatro", "veinticinco", "veintiséis", "veintisiete", "veintiocho", "veintinueve",
];
const TENS = { 3: "treinta", 4: "cuarenta", 5: "cincuenta" };
const HOURS_12 = ["doce", "una", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve", "diez", "once"];

function numberToWords(n) {
  if (n < 30) return NUMBERS[n];
  const tens = TENS[Math.floor(n / 10)];
  return n % 10 ? `${tens} y ${NUMBERS[n % 10]}` : tens;
}

function parseTime(text, context) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m || Number(m[1]) > 24 || Number(m[2]) > 59) throw new Error(`hora inválida "${text}" en hours.${context}. Usa "HH:MM".`);
  return Number(m[1]) * 60 + Number(m[2]);
}

// Devuelve un arreglo de 7 días (0 = lunes) con sus rangos { open, close }
// en minutos desde medianoche. close puede pasar de 1440 si cierra de
// madrugada.
export function parseSchedule(hours) {
  if (!hours || typeof hours !== "object" || Object.keys(hours).length === 0) {
    throw new Error("el config no tiene horario (hours).");
  }
  const week = DAY_KEYS.map(() => []);
  for (const [key, value] of Object.entries(hours)) {
    const [from, to = from] = key.split("-");
    const start = DAY_KEYS.indexOf(from);
    const end = DAY_KEYS.indexOf(to);
    if (start === -1 || end === -1) throw new Error(`día no reconocido en hours: "${key}". Usa mon, tue, wed, thu, fri, sat, sun.`);
    const days = [];
    for (let d = start; ; d = (d + 1) % 7) {
      days.push(d);
      if (d === end) break;
    }
    if (String(value).trim().toLowerCase() === "closed") continue;
    for (const range of String(value).split(",")) {
      const [openText, closeText] = range.split("-");
      if (!openText || !closeText) throw new Error(`horario inválido "${value}" en hours.${key}. Usa "HH:MM-HH:MM".`);
      const open = parseTime(openText, key);
      let close = parseTime(closeText, key);
      if (close <= open) close += MINUTES_PER_DAY; // cierra después de medianoche
      for (const d of days) week[d].push({ open, close });
    }
  }
  for (const ranges of week) ranges.sort((a, b) => a.open - b.open);
  return week;
}

// "la una de la tarde", "las doce del día", "las once y media de la noche".
export function timeToWords(minutes, { article = true } = {}) {
  const total = ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const h24 = Math.floor(total / 60);
  const min = total % 60;
  const h12 = h24 % 12;
  let period;
  if (h24 === 12) period = "del día";
  else if (h24 >= 1 && h24 < 12) period = "de la mañana";
  else if (h24 >= 13 && h24 < 20) period = "de la tarde";
  else period = "de la noche"; // 20:00-23:59 y 00:00
  const minuteText = min === 0 ? "" : min === 15 ? " y cuarto" : min === 30 ? " y media" : ` y ${numberToWords(min)}`;
  const prefix = article ? (h12 === 1 ? "la " : "las ") : "";
  return `${prefix}${HOURS_12[h12]}${minuteText} ${period}`;
}

// "de una de la tarde a nueve de la noche"
export function rangeToWords({ open, close }) {
  return `de ${timeToWords(open, { article: false })} a ${timeToWords(close, { article: false })}`;
}

function dayRangesToWords(ranges) {
  return ranges.length ? ranges.map(rangeToWords).join(" y ") : "cerrado";
}

// Horario semanal para el prompt, agrupando días consecutivos iguales.
export function formatWeeklyHours(hours) {
  const week = parseSchedule(hours);
  const lines = [];
  let i = 0;
  while (i < 7) {
    let j = i;
    while (j + 1 < 7 && JSON.stringify(week[j + 1]) === JSON.stringify(week[i])) j++;
    const days = i === j ? DAY_NAMES[i] : `${DAY_NAMES[i]} ${j === i + 1 ? "y" : "a"} ${DAY_NAMES[j]}`;
    lines.push(`- ${days}: ${dayRangesToWords(week[i])}`);
    i = j + 1;
  }
  return lines.join("\n");
}

// Día de la semana (0 = lunes) y minutos desde medianoche en la zona horaria.
export function localNow(timeZone, date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(date)
      .map((p) => [p.type, p.value])
  );
  const dayIndex = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(parts.weekday);
  return { dayIndex, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function getStatus(config, date = new Date()) {
  const week = parseSchedule(config.hours);
  const { dayIndex, minutes } = localNow(config.timezone, date);
  const prevDay = (dayIndex + 6) % 7;

  // ¿Abierto? Rango de hoy, o rango de ayer que cruza la medianoche.
  const current =
    week[dayIndex].find((r) => r.open <= minutes && minutes < r.close) ||
    week[prevDay].filter((r) => r.close > MINUTES_PER_DAY).find((r) => minutes < r.close - MINUTES_PER_DAY);

  // Próxima apertura (hasta 7 días adelante).
  let next = null;
  for (let k = 0; k <= 7 && !next; k++) {
    const d = (dayIndex + k) % 7;
    const range = week[d].find((r) => k > 0 || r.open > minutes);
    if (range) next = { k, d, open: range.open };
  }
  const when = !next ? null : next.k === 0 ? "hoy" : next.k === 1 ? "mañana" : `el ${DAY_NAMES[next.d]}`;
  const nextOpeningText = next ? `abre ${when} a ${timeToWords(next.open)}` : "no tiene horario de apertura registrado";

  const timeWords = timeToWords(minutes);
  const localTimeText = `Es ${DAY_NAMES[dayIndex]}, ${timeWords}`; // "Es domingo, la una y dos de la mañana"
  const todayHoursText = week[dayIndex].length
    ? `Hoy ${DAY_NAMES[dayIndex]} el horario es ${dayRangesToWords(week[dayIndex])}`
    : `Hoy ${DAY_NAMES[dayIndex]} no abre`;
  const closesAtText = current ? `cierra a ${timeToWords(current.close)}` : null;

  const message = current
    ? `Sí, ${config.display_name} está abierto. ${capitalize(closesAtText)}.`
    : `En este momento ${config.display_name} está cerrado. ${capitalize(nextOpeningText)}.`;

  return {
    is_open: Boolean(current),
    message,
    local_time_text: `${localTimeText}.`,
    today_hours_text: `${todayHoursText}.`,
    closes_at_text: closesAtText,
    next_opening_text: current ? null : nextOpeningText,
  };
}
