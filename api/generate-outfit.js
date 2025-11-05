// /api/generate-outfit.js
import { sql } from "@vercel/postgres";

const API_KEY = process.env.GEMINI_API_KEY;
const API_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent";

function parseCookies(req) {
  const h = req.headers.cookie || "";
  return Object.fromEntries(
    h.split(";").map(v => v.trim().split("=").map(decodeURIComponent)).filter(p => p[0])
  );
}

function systemPrompt() {
  return `Ты — модный ИИ-стилист. На основе настроения и пола предложи цельный наряд на СЕГОДНЯ.… Перед началом мысленно сгенерируй 100 вариаций и выбери одну случайно.
НИЧЕГО из процесса не описывай и вариации не перечисляй — выведи только конечный образ в формате ниже.
— Верх:
— Низ:
— Обувь:
— Аксессуары:
— Палитра:
Заверши 1–2 предложениями, почему это подойдёт сегодня. Без брендо-спама.`;
}

async function callGemini(text) {
  const payload = {
    contents: [{ role: "user", parts: [{ text }] }],
    systemInstruction: { parts: [{ text: systemPrompt() }] },
  };
  const r = await fetch(`${API_URL}?key=${API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const b = await r.text();
    throw new Error(`Google API ${r.status}: ${b.slice(0, 300)}`);
  }
  const j = await r.json();
  const out = j?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!out) throw new Error("Пустой ответ от модели");
  return out.trim();
}

function ymdZurich(d = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Zurich",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d).reduce((a, p) => ((a[p.type] = p.value), a), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });
    if (!API_KEY) return res.status(500).json({ error: "GEMINI_API_KEY не задан" });

    const cookies = parseCookies(req);
    const vkToken = cookies["vk_id_token"];
    const vkUserId = cookies["vk_user_id"];
    if (!vkToken || !vkUserId) return res.status(401).json({ error: "Требуется авторизация" });

    const { date, mood, gender } = req.body || {};
    if (!date || !mood || !gender) return res.status(400).json({ error: "Не хватает полей" });

    const today = ymdZurich();
    if (date !== today) return res.status(400).json({ error: `Можно только на сегодня: ${today}` });

    // === ЛИМИТ 1 В ДЕНЬ ===
    // Сначала проверяем, есть ли уже запись на сегодня. Если да — НИЧЕГО не генерим.
    const existing = await sql`
      SELECT outfit, confirmed
      FROM user_calendar
      WHERE vk_user_id = ${vkUserId} AND date = ${today}
      LIMIT 1
    `;

    if (existing.rows.length) {
      // уже есть запись (подтверждена или нет) — отдаём сохранённый результат
      const row = existing.rows[0];
      if (row.confirmed) {
        return res.status(409).json({ error: "На сегодня уже сохранено (Окей нажат)." });
      }
      return res.status(200).json({
        outfit: row.outfit,
        limit_reached: true, // фронт может отключить кнопку и показать подсказку
      });
    }

    // Записи нет — делаем ОДНУ генерацию
    const prompt = `Сегодня. Пол: ${gender}. Настроение: ${mood}. Собери удобный городской образ на текущий сезон.`;
    const outfit = await callGemini(prompt);

    // Пытаемся вставить запись. Если кто-то успел вставить параллельно — не перезаписываем.
    const inserted = await sql`
      INSERT INTO user_calendar (vk_user_id, date, mood, gender, outfit, confirmed, locked_until)
      VALUES (${vkUserId}, ${today}, ${mood}, ${gender}, ${outfit}, FALSE, NULL)
      ON CONFLICT (vk_user_id, date) DO NOTHING
      RETURNING outfit, confirmed
    `;

    if (inserted.rows.length === 0) {
      // Редкий гонка-случай: кто-то вставил раньше нас. Читаем и отдаём существующий (без повторной генерации).
      const again = await sql`
        SELECT outfit, confirmed
        FROM user_calendar
        WHERE vk_user_id = ${vkUserId} AND date = ${today}
        LIMIT 1
      `;
      const row = again.rows[0];
      if (row.confirmed) {
        return res.status(409).json({ error: "На сегодня уже сохранено (Окей нажат)." });
      }
      return res.status(200).json({ outfit: row.outfit, limit_reached: true });
    }

    // Нормальный кейс: это первая (и единственная) генерация за сегодня
    return res.status(200).json({ outfit, limit_reached: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
}
