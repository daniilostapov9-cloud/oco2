// /api/generate-outfit-image.js
// Dezgo text2image (JSON, X-Dezgo-Key) + кэш 1/день + циркут-брейкер. Ответ: PNG -> base64.

import { sql } from "@vercel/postgres";

export const config = { api: { bodyParser: { sizeLimit: "1mb" } } };

const DEZGO_KEY = process.env.DEZGO_API_KEY;
const DEZGO_URL = "https://api.dezgo.com/text2image"; // по докам

// ENV → жёсткая валидация под Dezgo
const MODEL   = (process.env.DEZGO_MODEL || "").trim();            // напр.: flux_1_schnell
const W_RAW   = Number(process.env.DEZGO_WIDTH  || 512);
const H_RAW   = Number(process.env.DEZGO_HEIGHT || 512);
const STEPS   = clampSteps(Number(process.env.DEZGO_STEPS || 8));  // 1..30
const GUIDE   = clampGuidance(Number(process.env.DEZGO_GUIDANCE || 3.0)); // 0..20
const SAMPLER = normalizeSampler((process.env.DEZGO_SAMPLER || "").trim()); // опц.

const ALLOWED_SIDE = new Set([256,320,384,448,512,576,640,704,768,832,896,960,1024]);

function clampSteps(x){ return Math.min(30, Math.max(1, Math.floor(Number.isFinite(x) ? x : 8))); }
function clampGuidance(x){ return Math.min(20, Math.max(0, Number.isFinite(x) ? x : 3.0)); }
function normalizeSampler(s){
  // Если не уверен — лучше не отправлять вовсе (дефолт у Dezgo нормальный).
  // У них конкретные названия, без подчёркиваний, чувствительны к регистру, напр. "DPM++ 2M Karras", "Euler a".
  const map = {
    "euler a": "Euler a",
    "euler_a": "Euler a",
    "Euler a": "Euler a",
    "dpm++ 2m": "DPM++ 2M",
    "dpmpp_2m": "DPM++ 2M",
    "dpm++ 2m karras": "DPM++ 2M Karras",
    "dpmpp_2m_karras": "DPM++ 2M Karras",
  };
  const key = s.toLowerCase();
  return map[key] || s;
}

function parseCookies(req){
  const h = req.headers.cookie || "";
  return Object.fromEntries(h.split(";").map(v => v.trim().split("=").map(decodeURIComponent)).filter(p => p[0]));
}
function ymdZurich(d = new Date()){
  const p = new Intl.DateTimeFormat("en-CA",{ timeZone:"Europe/Zurich", year:"numeric", month:"2-digit", day:"2-digit"})
    .formatToParts(d).reduce((a,x)=>(a[x.type]=x.value,a),{});
  return `${p.year}-${p.month}-${p.day}`;
}
function buildPrompt({ outfit, gender }){
  // Короткий безопасный промпт для пиксель-арта
  const style = `8-bit pixel art, limited clean palette, crisp sprite, full figure, simple studio background, no text.`;
  return `Generate a pixel person with description like in the text: "${outfit}" (gender: ${gender}). ${style}`;
}
const NEGATIVE = "nsfw, nude, watermark, logo, text, extra fingers, deformed hands, deformed face, blurry";

export default async function handler(req,res){
  try{
    if (req.method !== "POST") return res.status(405).json({ error:"Method Not Allowed" });
    if (!DEZGO_KEY) return res.status(500).json({ error:"DEZGO_API_KEY не задан" });

    const cookies  = parseCookies(req);
    const vkToken  = cookies["vk_id_token"];
    const vkUserId = cookies["vk_user_id"];
    if (!vkToken || !vkUserId) return res.status(401).json({ error:"Требуется авторизация" });

    const { date, outfit, gender } = req.body || {};
    if (!date || !outfit || !gender) return res.status(400).json({ error:"Не хватает полей (date, outfit, gender)" });

    const today = ymdZurich();
    if (date !== today) return res.status(400).json({ error:`Картинка доступна только на сегодня: ${today}` });

    // --- читаем/готовим запись на сегодня
    const existing = await sql`
      SELECT image_base64, image_generated, image_error, image_attempted_today
      FROM user_calendar
      WHERE vk_user_id=${vkUserId} AND date=${today}
      LIMIT 1
    `;
    if (existing.rows.length){
      const r = existing.rows[0];
      if (r.image_generated && r.image_base64){
        return res.status(200).json({ image_base64: r.image_base64, cached:true });
      }
      if (!r.image_generated && r.image_attempted_today && r.image_error){
        return res.status(429).json({
          error:"image_generation_disabled_for_today",
          details:"Сегодня генерация у провайдера уже падала. Попробуйте завтра."
        });
      }
    }

    // --- первичная запись + флаг «попытки сегодня»
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

    // --- строгая валидация размеров под Dezgo (кратно 64)
    const W = ALLOWED_SIDE.has(W_RAW) ? W_RAW : 512;
    const H = ALLOWED_SIDE.has(H_RAW) ? H_RAW : 512;

    // --- сбор JSON-запроса (рекомендованный формат по докам)
    const prompt = buildPrompt({ outfit, gender });
    const body = {
      prompt,
      negative_prompt: NEGATIVE,
      width: W,
      height: H,
      steps: STEPS,
      guidance: GUIDE,
      // model/sampler — ТОЛЬКО если заданы; иначе используем дефолты Dezgo (минимум шансов на 400)
      ...(MODEL   ? { model: MODEL }   : {}),
      ...(SAMPLER ? { sampler: SAMPLER } : {})
      // seed, upscale, format и др. — по желанию; ответ всё равно будет PNG-байтами
    };

    const resp = await fetch(DEZGO_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",       // рекомендованный формат
        "X-Dezgo-Key": DEZGO_KEY                  // аутентификация по докам
      },
      body: JSON.stringify(body)
    });

    const ct = resp.headers.get("content-type") || "";

    if (!resp.ok) {
      // Читаем текст ошибки (у Dezgo и 400/4xx приходят JSON/текст), сохраняем в БД
      let errText = "";
      try { errText = await resp.text(); } catch { errText = `HTTP ${resp.status} (${ct})`; }
      await sql`UPDATE user_calendar SET image_error=${String(errText).slice(0,1000)} WHERE vk_user_id=${vkUserId} AND date=${today}`;
      return res.status(resp.status).json({ error:`Dezgo ${resp.status}`, details: String(errText).slice(0,800) });
    }

    // У Dezgo тело — PNG (raw). Конвертируем в base64 и кэшируем.
    let b64;
    if (ct.startsWith("image/")) {
      const buf = Buffer.from(await resp.arrayBuffer());
      b64 = buf.toString("base64");
    } else {
      // На всякий случай: если вернулся JSON с ссылкой
      const t = await resp.text();
      try {
        const j = JSON.parse(t);
        const url = j?.image || j?.url || j?.data?.image;
        if (!url) throw new Error("no image field");
        const r2 = await fetch(url);
        if (!r2.ok) throw new Error("fetch image " + r2.status);
        const buf = Buffer.from(await r2.arrayBuffer());
        b64 = buf.toString("base64");
      } catch (e) {
        await sql`UPDATE user_calendar SET image_error=${String(e.message).slice(0,1000)} WHERE vk_user_id=${vkUserId} AND date=${today}`;
        return res.status(500).json({ error:"Dezgo: неожиданный ответ", details: String(e.message) });
      }
    }

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
