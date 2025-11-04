// /api/generate-outfit-image.js
import { sql } from "@vercel/postgres";

export const config = { api: { bodyParser: { sizeLimit: "1mb" } } };

const LZ_BASE   = process.env.LAOZHANG_BASE  || "https://api.laozhang.ai/v1";
const LZ_KEY    = process.env.LAOZHANG_API_KEY;
const LZ_MODEL  = process.env.LAOZHANG_MODEL || "dall-e-2"; // Как вы и хотели
const LZ_SIZE   = process.env.LAOZHANG_SIZE  || "512x512";     // Совместимо с gpt-image-1
// const LZ_QUALITY= process.env.LAOZHANG_QUALITY || "low"; // Эту строку не используем

function parseCookies(req){
  const h = req.headers.cookie || "";
  return Object.fromEntries(h.split(";").map(v=>v.trim().split("=").map(decodeURIComponent)).filter(p=>p[0]));
}
function ymdZurich(d=new Date()){
  const p = new Intl.DateTimeFormat("en-CA",{ timeZone:"Europe/Zurich",year:"numeric",month:"2-digit",day:"2-digit"})
    .formatToParts(d).reduce((a,x)=>(a[x.type]=x.value,a),{});
  return `${p.year}-${p.month}-${p.day}`;
}
function buildPrompt({ outfit, gender }){
  const prefix = `Generate me pixel person with description like in the text: `;
  const style  = ` Pixel art, clean palette, crisp sprite, full figure, simple studio background, no text.`;
  return `${prefix}"${outfit}" (gender: ${gender}).${style}`;
}

export default async function handler(req,res){
  try{
    if (req.method !== "POST") return res.status(405).json({ error:"Method Not Allowed" });
    if (!LZ_KEY) return res.status(500).json({ error:"LAOZHANG_API_KEY не задан" });

    const cookies  = parseCookies(req);
    const vkToken  = cookies["vk_id_token"];
    const vkUserId = cookies["vk_user_id"];
    if (!vkToken || !vkUserId) return res.status(401).json({ error:"Требуется авторизация" });

    const { date, outfit, gender } = req.body || {};
    if (!date || !outfit || !gender) return res.status(400).json({ error:"Не хватает полей (date, outfit, gender)" });

    const today = ymdZurich();
    if (date !== today) return res.status(400).json({ error:`Картинка доступна только на сегодня: ${today}` });

    // кэш «1/день»
    const cached = await sql`
      SELECT image_base64 FROM user_calendar
      WHERE vk_user_id=${vkUserId} AND date=${today} AND image_generated = TRUE
      LIMIT 1
    `;
    if (cached.rows.length && cached.rows[0].image_base64){
      return res.status(200).json({ image_base64: cached.rows[0].image_base64, cached:true });
    }

    // гарантия записи дня
    await sql`
      INSERT INTO user_calendar (vk_user_id,date,mood,gender,outfit,confirmed,locked_until,image_generated)
      VALUES (${vkUserId}, ${today}, ${"—"}, ${gender}, ${outfit}, FALSE, NULL, FALSE)
      ON CONFLICT (vk_user_id,date) DO NOTHING
    `;

    // --- ИСПРАВЛЕННЫЙ БЛОК ---
    // вызов LaoZhang по OpenAI Images API
    const prompt = buildPrompt({ outfit, gender });
    
    // Параметр 'quality' убран, так как он несовместим
    // с моделями DALL-E 2 (gpt-image-1) и размером 512x512.
    // Это и вызывало ошибку 500.
    const payload = {
      model: LZ_MODEL,
      prompt,
      size: LZ_SIZE,
      response_format: "b64_json"
    };
    // --- КОНЕЦ ИСПРАВЛЕНИЯ ---

    const resp = await fetch(`${LZ_BASE}/images/generations`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${LZ_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const text = await resp.text();
    if (!resp.ok) {
      // Печатаем оригинальный ответ провайдера, чтобы не гадать
      return res.status(resp.status).json({ error:`LaoZhang API ${resp.status}`, details: text.slice(0,1000) });
    }

    let data;
    try { data = JSON.parse(text); }
    catch { return res.status(500).json({ error:"LaoZhang: не-JSON", details: text.slice(0,400) }); }

    const b64 = data?.data?.[0]?.b64_json || data?.data?.[0]?.base64;
    if (!b64) return res.status(500).json({ error:"LaoZhang: нет b64 в ответе", details: JSON.stringify(data).slice(0,600) });

    await sql`
      UPDATE user_calendar
      SET image_base64=${b64}, image_generated=TRUE
      WHERE vk_user_id=${vkUserId} AND date=${today}
    `;
    return res.status(200).json({ image_base64: b64 });
  }catch(e){
    console.error(e);
    return res.status(500).json({ error:e.message });
  }
}
