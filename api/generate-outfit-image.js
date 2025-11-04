// /api/generate-outfit-image.js
// OpenAI Images (gpt-image-1) + кэш 1/день + циркут-брейкер на ошибки.

import { sql } from "@vercel/postgres";

export const config = { api: { bodyParser: { sizeLimit: "1mb" } } };

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const IMAGE_MODEL    = process.env.OPENAI_IMAGE_MODEL || "gpt-image-1";
// size строго валидируем: 256x256 | 512x512 | 1024x1024
const RAW_SIZE       = (process.env.OPENAI_IMAGE_SIZE || "512x512").toLowerCase().replace(/\s+/g, "");
const ALLOWED_SIZES  = new Set(["256x256", "512x512", "1024x1024"]);
const IMAGE_SIZE     = ALLOWED_SIZES.has(RAW_SIZE) ? RAW_SIZE : "512x512";

function parseCookies(req) {
  const h = req.headers.cookie || "";
  return Object.fromEntries(
    h.split(";").map(v => v.trim().split("=").map(decodeURIComponent)).filter(p => p[0])
  );
}
function ymdZurich(d = new Date()) {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Zurich", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {});
  return `${p.year}-${p.month}-${p.day}`;
}
function buildPrompt({ outfit, gender }) {
  const prefix = `Generate me pixel person with description like in the text: `;
  const style  = ` Pixel art, clean palette, crisp sprite, full figure, simple studio background, no text.`;
  return `${prefix}"${outfit}" (gender: ${gender}).${style}`;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });
    if (!OPENAI_API_KEY) return res.status(500).json({ error: "OPENAI_API_KEY не задан" });

    const cookies  = parseCookies(req);
    const vkToken  = cookies["vk_id_token"];
    const vkUserId = cookies["vk_user_id"];
    if (!vkToken || !vkUserId) return res.status(401).json({ error: "Требуется авторизация" });

    const { date, outfit, gender } = req.body || {};
    if (!date || !outfit || !gender) return res.status(400).json({ error: "Не хватает полей (date, outfit, gender)" });

    const today = ymdZurich();
    if (date !== today) return res.status(400).json({ error: `Картинка доступна только на сегодня: ${today}` });

    // 0) кэш «1/день»
    const existing = await sql`
      SELECT image_base64, image_generated, image_error, image_attempted_today
      FROM user_calendar
      WHERE vk_user_id=${vkUserId} AND date=${today}
      LIMIT 1
    `;

    if (existing.rows.length) {
      const row = existing.rows[0];

      // если уже сгенерировано — отдаём кэш
      if (row.image_generated && row.image_base64) {
        return res.status(200).json({ image_base64: row.image_base64, cached: true });
      }

      // если сегодня уже была неудачная попытка — блокируем до завтра
      if (!row.image_generated && row.image_attempted_today && row.image_error) {
        return res.status(429).json({
          error: "image_generation_disabled_for_today",
          details: "Сегодня генерация изображения уже падала у провайдера. Попробуйте завтра."
        });
      }
    }

    // 1) гарантируем запись дня (для привязки кэша) и отметим попытку
    await sql`
      INSERT INTO user_calendar (vk_user_id, date, mood, gender, outfit, confirmed, locked_until, image_generated, image_attempted_today, image_error)
      VALUES (${vkUserId}, ${today}, ${"—"}, ${gender}, ${outfit}, FALSE, NULL, FALSE, TRUE, NULL)
      ON CONFLICT (vk_user_id, date) DO UPDATE
      SET gender = EXCLUDED.gender,
          outfit = CASE WHEN user_calendar.outfit IS NULL OR user_calendar.outfit = '' THEN EXCLUDED.outfit ELSE user_calendar.outfit END,
          image_attempted_today = TRUE,
          image_error = NULL
    `;

    // 2) вызов OpenAI Images API
    const prompt = buildPrompt({ outfit, gender });

    // ВАЖНО: без поля "quality" — оно часто даёт 400 на Images API
    const payload = {
      model: IMAGE_MODEL,
      prompt,
      size: IMAGE_SIZE,
      response_format: "b64_json"
    };

    const resp = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const text = await resp.text();

    if (!resp.ok) {
      // сохраняем причину, чтобы больше не бить провайдера сегодня
      await sql`
        UPDATE user_calendar
        SET image_error=${text.slice(0, 1000)}
        WHERE vk_user_id=${vkUserId} AND date=${today}
      `;
      return res.status(resp.status).json({ error: `OpenAI Images ${resp.status}`, details: text.slice(0, 800) });
    }

    let data;
    try { data = JSON.parse(text); }
    catch {
      await sql`
        UPDATE user_calendar
        SET image_error=${text.slice(0, 1000)}
        WHERE vk_user_id=${vkUserId} AND date=${today}
      `;
      return res.status(500).json({ error: "OpenAI: не-JSON", details: text.slice(0, 400) });
    }

    const b64 = data?.data?.[0]?.b64_json || data?.data?.[0]?.base64;
    if (!b64) {
      const dump = JSON.stringify(data).slice(0, 500);
      await sql`UPDATE user_calendar SET image_error=${dump} WHERE vk_user_id=${vkUserId} AND date=${today}`;
      return res.status(500).json({ error: "OpenAI: нет b64 в ответе", details: dump });
    }

    // 3) кэш успеха и ответ
    await sql`
      UPDATE user_calendar
      SET image_base64=${b64}, image_generated=TRUE, image_error=NULL
      WHERE vk_user_id=${vkUserId} AND date=${today}
    `;
    return res.status(200).json({ image_base64: b64 });

  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
}
