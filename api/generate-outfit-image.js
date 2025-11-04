// /api/generate-outfit-image.js
import { sql } from "@vercel/postgres";

export const config = { api: { bodyParser: { sizeLimit: "1mb" } } };

const DEZGO_KEY = process.env.DEZGO_API_KEY;

// --- Твои старые функции (без изменений) ---
function parseCookies(req){/*...твой код...*/}
function ymdZurich(d=new Date()){/*...твой код...*/}
function buildPrompt({ outfit, gender }){/*...твой код...*/}

export default async function handler(req,res){
  try{
    if (req.method !== "POST") return res.status(405).json({ error:"Method Not Allowed" });
    if (!DEZGO_KEY) return res.status(500).json({ error:"DEZGO_API_KEY не задан" });

    // --- (Весь твой код проверки: cookies, req.body, кэш, sql insert) ---
    const cookies  = parseCookies(req);
    const vkToken  = cookies["vk_id_token"];
    const vkUserId = cookies["vk_user_id"];
    if (!vkToken || !vkUserId) return res.status(401).json({ error:"Требуется авторизация" });
    const { date, outfit, gender } = req.body || {};
    if (!date || !outfit || !gender) return res.status(400).json({ error:"Не хватает полей (date, outfit, gender)" });
    const today = ymdZurich();
    if (date !== today) return res.status(400).json({ error:`Картинка доступна только на сегодня: ${today}` });
    const cached = await sql`SELECT image_base64 FROM user_calendar WHERE vk_user_id=${vkUserId} AND date=${today} AND image_generated = TRUE LIMIT 1`;
    if (cached.rows.length && cached.rows[0].image_base64){
      return res.status(200).json({ image_base64: cached.rows[0].image_base64, cached:true });
    }
    await sql`INSERT INTO user_calendar (vk_user_id,date,mood,gender,outfit,confirmed,locked_until,image_generated) VALUES (${vkUserId}, ${today}, ${"—"}, ${gender}, ${outfit}, FALSE, NULL, FALSE) ON CONFLICT (vk_user_id,date) DO NOTHING`;
    // --- (Конец твоего кода проверки) ---


    // --- НАЧАЛО: ЛОГИКА DEZGO FLUX ---
    
    const prompt = buildPrompt({ outfit, gender });

    const payload = {
      prompt: prompt,
      width: 1024,
      height: 1024
      // response_format убран
    };

    const resp = await fetch("https://api.dezgo.com/text2image_flux", {
      method: "POST",
      headers: {
        "X-Dezgo-Key": DEZGO_KEY,
        "Content-Type": "application/json",
        // Мы просим JSON, но Dezgo, похоже, его игнорирует
        "Accept": "application/json" 
      },
      body: JSON.stringify(payload)
    });

    // Обработка ОШИБОК (4xx, 5xx)
    if (!resp.ok) {
      // Если Dezgo вернул ошибку, он вернет JSON, и мы его прочитаем
      const errDetails = await resp.json().catch(() => resp.text());
      return res.status(resp.status).json({ error:`Dezgo FLUX API ${resp.status}`, details: errDetails });
    }

    // --- ИСПРАВЛЕННЫЙ БЛОК ---
    // Обработка УСПЕХА (200 OK)
    // Dezgo (FLUX) вернул нам чистый PNG.
    // Мы не можем использовать resp.json().
    // Читаем сырые данные (buffer) и конвертируем в b64 вручную.
    
    const buffer = await resp.arrayBuffer();
    const b64 = Buffer.from(buffer).toString('base64');
    
    // --- КОНЕЦ ИСПРАВЛЕНИЯ ---

    if (!b64) {
      // Эта ошибка вряд ли случится, но для безопасности
      return res.status(500).json({ error:"Dezgo FLUX: не удалось конвертировать PNG в b64" });
    }
    
    // --- КОНЕЦ: ЛОГИКА DEZGO FLUX ---

    // Сохранение в SQL (твой код)
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
