// /api/generate-outfit-image.js
// Dezgo text2image + кэш 1/день + «циркут-брейкер» (если провайдер падал — до завтра не дёргаем).

import { sql } from "@vercel/postgres";

export const config = { api: { bodyParser: { sizeLimit: "1mb" } } };

const DEZGO_API_KEY = process.env.DEZGO_API_KEY;
const DEZGO_URL = "https://api.dezgo.com/text2image"; // синхронный T2I

const MODEL    = (process.env.DEZGO_MODEL || "").trim();      // опционально
const WIDTH    = Number(process.env.DEZGO_WIDTH || 512);
const HEIGHT   = Number(process.env.DEZGO_HEIGHT || 512);
const STEPS    = Number(process.env.DEZGO_STEPS || 8);
const GUIDANCE = Number(process.env.DEZGO_GUIDANCE || 3.5);
const SAMPLER  = (process.env.DEZGO_SAMPLER || "").trim();    // опционально

function parseCookies(req){
  const h = req.headers.cookie || "";
  return Object.fromEntries(h.split(";").map(v => v.trim().split("=").map(decodeURIComponent)).filter(p => p[0]));
}
function ymdZurich(d = new Date()){
  const p = new Intl.DateTimeFormat("en-CA",{ timeZone:"Europe/Zurich", year:"numeric", month:"2-digit", day:"2-digit" })
    .formatToParts(d).reduce((a,x)=>(a[x.type]=x.value,a),{});
  return `${p.year}-${p.month}-${p.day}`;
}
function buildPrompt({ outfit, gender }){
  // короткий, безопасный и «дешёвый» для рисовалки
  const prefix = `Generate me a pixel person with description like in the text: `;
  const style  = ` Pixel art, clean palette, crisp sprite, full figure, simple studio background, no text.`;
  return `${prefix}"${outfit}" (gender: ${gender}).${style}`;
}
const NEGATIVE = "nsfw, nude, watermark, logo, text, extra fingers, deformed hands";

export default async function handler(req,res){
  try{
    if (req.method !== "POST") return res.status(405).json({ error:"Method Not Allowed" });
    if (!DEZGO_API_KEY)      return res.status(500).json({ error:"DEZGO_API_KEY не задан" });

    const cookies  = parseCookies(req);
    const vkToken  = cookies["vk_id_token"];
    const vkUserId = cookies["vk_user_id"];
    if (!vkToken || !vkUserId) return res.status(401).json({ error:"Требуется авторизация" });

    const { date, outfit, gender } = req.body || {};
    if (!date || !outfit || !gender) return res.status(400).json({ error:"Не хватает полей (date, outfit, gender)" });

    const today = ymdZurich();
    if (date !== today) return res.status(400).json({ error:`Картинка доступна только на сегодня: ${today}` });

    // --- читаем запись на сегодня
    const existing = await sql`
      SELECT image_base64, image_generated, image_error, image_attempted_today
      FROM user_calendar
      WHERE vk_user_id=${vkUserId} AND date=${today}
      LIMIT 1
    `;
    if (existing.rows.length){
      const row = existing.rows[0];
      if (row.image_generated && row.image_base64){
        return res.status(200).json({ image_base64: row.image_base64, cached:true });
      }
      if (!row.image_generated && row.image_attempted_today && row.image_error){
        return res.status(429).json({
          error: "image_generation_disabled_for_today",
          details: "Сегодня генерация у провайдера уже падала. Попробуйте завтра."
        });
      }
    }

    // --- гарантируем запись и отметим попытку
    await sql`
      INSERT INTO user_calendar (vk_user_id,date,mood,gender,outfit,confirmed,locked_until,
                                 image_generated,image_attempted_today,image_error)
      VALUES (${vkUserId}, ${today}, ${"—"}, ${gender}, ${outfit}, FALSE, NULL, FALSE, TRUE, NULL)
      ON CONFLICT (vk_user_id,date) DO UPDATE
      SET gender = EXCLUDED.gender,
          outfit = CASE WHEN user_calendar.outfit IS NULL OR user_calendar.outfit='' THEN EXCLUDED.outfit ELSE user_calendar.outfit END,
          image_attempted_today = TRUE,
          image_error = NULL
    `;

    // --- собираем форму для Dezgo (multipart/form-data)
    const prompt = buildPrompt({ outfit, gender });
    const form = new FormData();
    form.append("prompt", prompt);
    form.append("negative_prompt", NEGATIVE);
    form.append("width", String(WIDTH));
    form.append("height", String(HEIGHT));
    form.append("steps", String(STEPS));
    form.append("guidance", String(GUIDANCE));
    if (SAMPLER) form.append("sampler", SAMPLER);
    if (MODEL)   form.append("model",   MODEL);

    // ВАЖНО: Dezgo синхронный эндпоинт возвращает бинарный PNG
    const resp = await fetch(DEZGO_URL, {
      method: "POST",
      headers: { "X-Dezgo-Key": DEZGO_API_KEY }, // их заголовок авторизации
      body: form
    });

    // Читаем ответ целиком (может быть PNG или JSON с ошибкой)
    const ct = resp.headers.get("content-type") || "";
    if (!resp.ok) {
      const errText = ct.includes("application/json") ? await resp.text() : `HTTP ${resp.status} (${ct})`;
      await sql`UPDATE user_calendar SET image_error=${String(errText).slice(0,1000)} WHERE vk_user_id=${vkUserId} AND date=${today}`;
      return res.status(resp.status).json({ error:`Dezgo ${resp.status}`, details: String(errText).slice(0,800) });
    }

    let b64;
    if (ct.startsWith("image/")) {
      const buf = Buffer.from(await resp.arrayBuffer());
      b64 = buf.toString("base64");
    } else {
      // иногда API может вернуть JSON с ссылкой — попробуем распарсить
      const text = await resp.text();
      try {
        const j = JSON.parse(text);
        const url = j?.image || j?.url || j?.data?.image;
        if (!url) throw new Error("no image field");
        const r2 = await fetch(url);
        if (!r2.ok) throw new Error("fetch image " + r2.status);
        const buf = Buffer.from(await r2.arrayBuffer());
        b64 = buf.toString("base64");
      } catch (e) {
        await sql`UPDATE user_calendar SET image_error=${text.slice(0,1000)} WHERE vk_user_id=${vkUserId} AND date=${today}`;
        return res.status(500).json({ error:"Dezgo: неожиданный ответ", details: text.slice(0,800) });
      }
    }

    // --- кэшируем успех
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
