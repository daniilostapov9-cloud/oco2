// /api/generate-outfit.js
const API_KEY = process.env.GEMINI_API_KEY;
const API_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent";
const LOCK_MINUTES = 15;

import { sql } from "@vercel/postgres";

function parseCookies(req) {
  const h = req.headers.cookie || "";
  return Object.fromEntries(
    h
      .split(";")
      .map((v) => v.trim().split("=").map(decodeURIComponent))
      .filter((p) => p[0])
  );
}

function systemPrompt() {
  return `Ты — модный ИИ-стилист. На основе настроения и пола предложи цельный наряд на СЕГОДНЯ.
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
  })
    .formatToParts(d)
    .reduce((a, p) => ((a[p.type] = p.value), a), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST")
      return res.status(405).json({ error: "Method Not Allowed" });
    if (!API_KEY) return res.status(500).json({ error: "GEMINI_API_KEY не задан" });

    const cookies = parseCookies(req);
    const vkToken = cookies["vk_id_token"];
    const vkUserId = cookies["vk_user_id"];
    if (!vkToken || !vkUserId)
      return res.status(401).json({ error: "Требуется авторизация" });

    const { date, mood, gender } = req.body || {};
    if (!date || !mood || !gender)
      return res.status(400).json({ error: "Не хватает полей" });

    const today = ymdZurich();
    if (date !== today)
      return res.status(400).json({ error: `Можно только на сегодня: ${today}` });

    // 1) проверяем запись на сегодня
    const { rows } = await sql`
      SELECT mood, gender, outfit, confirmed,
             locked_until AT TIME ZONE 'Europe/Zurich' AS locked_until
      FROM user_calendar
      WHERE vk_user_id = ${vkUserId} AND date = ${today}
    `;

    if (rows.length && rows[0].confirmed) {
      return res
        .status(409)
        .json({ error: "На сегодня уже сохранено (Окей нажат)." });
    }

    // если замок ещё активен — возвращаем прежний текст
    const lockedUntil = rows[0]?.locked_until
      ? new Date(rows[0].locked_until)
      : null;
    const nowZurich = new Date(); // сервер в UTC, но сравнение по абсолютному времени ок
    if (lockedUntil && lockedUntil > nowZurich && rows[0]?.outfit) {
      const human = lockedUntil.toLocaleTimeString("ru-RU", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Europe/Zurich",
      });
      return res
        .status(200)
        .json({ outfit: rows[0].outfit, locked_until_human: human });
    }

    // 2) генерим новый, сохраняем и ставим замок (фикс: параметризованный interval)
    const prompt = `Сегодня. Пол: ${gender}. Настроение: ${mood}. Собери удобный городской образ на текущий сезон.`;
    const outfit = await callGemini(prompt);

    const intervalParam = `${LOCK_MINUTES} minutes`; // будет $6/$7 параметром
    await sql`
      INSERT INTO user_calendar (vk_user_id, date, mood, gender, outfit, confirmed, locked_until)
      VALUES (${vkUserId}, ${today}, ${mood}, ${gender}, ${outfit}, FALSE, NOW() + ${intervalParam}::interval)
      ON CONFLICT (vk_user_id, date) DO UPDATE
      SET mood = EXCLUDED.mood,
          gender = EXCLUDED.gender,
          outfit = EXCLUDED.outfit,
          confirmed = FALSE,
          locked_until = NOW() + ${intervalParam}::interval
    `;

    const human = new Date(Date.now() + LOCK_MINUTES * 60000).toLocaleTimeString(
      "ru-RU",
      { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Zurich" }
    );

    return res.status(200).json({ outfit, locked_until_human: human });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
}
