// /api/generate-outfit-image.js
import { sql } from "@vercel/postgres";

export const config = { api: { bodyParser: { sizeLimit: "1mb" } } };

const NOVITA_API_KEY   = process.env.NOVITA_API_KEY;
// можно переопределить роут в ENV при желании
const NOVITA_IMAGE_URL = process.env.NOVITA_IMAGE_URL
  || "https://api.novita.ai/v3/openai/images/generations";

// модель Novita в OpenAI-совместимом API
const NOVITA_MODEL = process.env.NOVITA_MODEL || "flux-dev"; // например: "sdxl", "sdxl-turbo", "flux-dev"

function parseCookies(req) {
  const h = req.headers.cookie || "";
  return Object.fromEntries(
    h.split(";").map(v => v.trim().split("=").map(decodeURIComponent)).filter(p => p[0])
  );
}
function ymdZurich(d = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Zurich", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(d).reduce((a, p) => ((a[p.type] = p.value), a), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function buildPrompt({ outfit, gender }) {
  const prefix = `Generate me pixel person with description like in the text: `;
  const style  = ` Pixel art, clean palette, crisp sprite, full figure, simple studio background, no text.`;
  return `${prefix}"${outfit}" (gender: ${gender}).${style}`;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });
    if (!NOVITA_API_KEY)     return res.status(500).json({ error: "NOVITA_API_KEY не задан" });

    const cookies  = parseCookies(req);
    const vkToken  = cookies["vk_id_token"];
    const vkUserId = cookies["vk_user_id"];
    if (!vkToken || !vkUserId) return res.status(401).json({ error: "Требуется авторизация" });

    const { date, outfit, gender } = req.body || {};
    if (!date || !outfit || !gender) return res.status(400).json({ error: "Не хватает полей (date, outfit, gender)" });

    const today = ymdZurich();
    if (date !== today) return res.status(400).json({ error: `Картинка доступна только на сегодня: ${today}` });

    // 0) кэш сегодняшнего дня
    const cached = await sql`
      SELECT image_base64 FROM user_calendar
      WHERE vk_user_id=${vkUserId} AND date=${today} AND image_generated = TRUE
      LIMIT 1
    `;
    if (cached.rows.length && cached.rows[0].image_base64) {
      return res.status(200).json({ image_base64: cached.rows[0].image_base64, cached: true });
    }

    // 1) гарантируем запись на сегодня (для привязки кэша)
    await sql`
      INSERT INTO user_calendar (vk_user_id,date,mood,gender,outfit,confirmed,locked_until,image_generated)
      VALUES (${vkUserId}, ${today}, ${"—"}, ${gender}, ${outfit}, FALSE, NULL, FALSE)
      ON CONFLICT (vk_user_id,date) DO NOTHING
    `;

    // 2) вызов Novita (OpenAI-style Images)
    const prompt = buildPrompt({ outfit, gender });

    // В OpenAI-совместимом API поля такие:
    // { model, prompt, size, response_format }
    const payload = {
      model: NOVITA_MODEL,
      prompt,
      size: "512x512",                 // дешёвый/быстрый размер (можешь 256x256 ещё дешевле)
      response_format: "b64_json"
    };

    const resp = await fetch(NOVITA_IMAGE_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${NOVITA_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const text = await resp.text();
    if (!resp.ok) {
      // вернём полный ответ, чтобы сразу видно было, если URL/модель не та
      return res.status(resp.status).json({ error: `Novita API ${resp.status}: ${text.slice(0,500)}` });
    }

    let data;
    try { data = JSON.parse(text); } catch {
      return res.status(500).json({ error: "Novita вернула не-JSON", details: text.slice(0,300) });
    }

    const b64 = data?.data?.[0]?.b64_json || data?.data?.[0]?.base64 || data?.images?.[0]?.b64_json;
    if (!b64) {
      return res.status(500).json({ error: "Novita: нет b64 в ответе", details: JSON.stringify(data).slice(0,400) });
    }

    // 3) кэшируем и отдаём
    await sql`
      UPDATE user_calendar
      SET image_base64=${b64}, image_generated=TRUE
      WHERE vk_user_id=${vkUserId} AND date=${today}
    `;
    return res.status(200).json({ image_base64: b64 });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
}
