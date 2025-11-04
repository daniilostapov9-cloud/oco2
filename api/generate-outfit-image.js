// /api/generate-outfit-image.js
import { sql } from "@vercel/postgres";

export const config = { api: { bodyParser: { sizeLimit: "1mb" } } };

const DEZGO_KEY = process.env.DEZGO_API_KEY;

// --- Твои старые функции (без изменений) ---
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
    if (!DEZGO_KEY) return res.status(500).json({ error:"DEZGO_API_KEY не задан" });

    // --- НАЧАЛО: ПОЛНЫЙ БЛОК ПРОВЕРОК ---
    
    // 1. Проверка Cookies
    const cookies  = parseCookies(req);
    const vkToken  = cookies["vk_id_token"];
    const vkUserId = cookies["vk_user_id"];
    if (!vkToken || !vkUserId) return res.status(401).json({ error:"Требуется авторизация" });

    // 2. Проверка Тела Запроса
    const { date, outfit, gender } = req.body || {};
    if (!date || !outfit || !gender) return res.status(400).json({ error:"Не хватает полей (date, outfit, gender)" });

    // 3. Проверка Даты
    const today = ymdZurich();
    if (date !== today) return res.status(400).json({ error:`Картинка доступна только на сегодня: ${today}` });

    // --- ИЗМЕНЕНИЕ: ПРОВЕРКА ЛИМИТА ---
    
    // 4. Проверяем, не исчерпан ли уже лимит
    const limitCheck = await sql`
      SELECT image_generated FROM user_calendar
      WHERE vk_user_id=${vkUserId} AND date=${today}
      LIMIT 1
    `;
    
    // Если image_generated=true, лимит исчерпан
    if (limitCheck.rows.length && limitCheck.rows[0].image_generated === true){
      return res.status(429).json({ error: "Лимит на генерацию (1 в день) исчерпан" });
    }

    // 5. Гарантия Записи (чтобы строка существовала)
    // Мы больше не вставляем 'image_generated=FALSE'
    await sql`
      INSERT INTO user_calendar (vk_user_id,date,mood,gender,outfit,confirmed,locked_until)
      VALUES (${vkUserId}, ${today}, ${"—"}, ${gender}, ${outfit}, FALSE, NULL)
      ON CONFLICT (vk_user_id,date) DO NOTHING
    `;
    // --- КОНЕЦ: БЛОК ПРОВЕРОК ИЗМЕНЕН ---


    // --- НАЧАЛО: ЛОГИКА DEZGO FLUX (работает охуенно) ---
    
    const prompt = buildPrompt({ outfit, gender });

    const payload = {
      prompt: prompt,
      width: 1024,
      height: 1024
    };

    const resp = await fetch("https://api.dezgo.com/text2image_flux", {
      method: "POST",
      headers: {
        "X-Dezgo-Key": DEZGO_KEY,
        "Content-Type": "application/json",
        "Accept": "application/json" 
      },
      body: JSON.stringify(payload)
    });

    if (!resp.ok) {
      const errDetails = await resp.json().catch(() => resp.text());
      return res.status(resp.status).json({ error:`Dezgo FLUX API ${resp.status}`, details: errDetails });
    }
    
    // Конвертируем PNG-ответ в b64 (как и раньше)
    const buffer = await resp.arrayBuffer();
    const b64 = Buffer.from(buffer).toString('base64');

    if (!b64) {
      return res.status(500).json({ error:"Dezgo FLUX: не удалось конвертировать PNG в b64" });
    }
    
    // --- КОНЕЦ: ЛОГИКА DEZGO FLUX ---

    // --- ИЗМЕНЕНИЕ: НЕ СОХРАНЯЕМ b64, А ПРОСТО СТАВИМ ФЛАГ ЛИМИТА ---
    await sql`
      UPDATE user_calendar
      SET image_generated = TRUE 
      WHERE vk_user_id=${vkUserId} AND date=${today}
    `;
    
    // Отдаем b64 на фронтенд (он его покажет 1 раз и все)
    return res.status(200).json({ image_base64: b64 });

  }catch(e){
    console.error(e);
    return res.status(500).json({ error:e.message });
  }
}
