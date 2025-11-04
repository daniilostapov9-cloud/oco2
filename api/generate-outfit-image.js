// /api/generate-outfit-image.js
import { sql } from "@vercel/postgres";

export const config = { api: { bodyParser: { sizeLimit: "1mb" } } };

// --- Константа Dezgo ---
const DEZGO_KEY = process.env.DEZGO_API_KEY;

// --- Твои старые функции ---
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
  // 'outfit' здесь будет на русском
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

    // 2. Проверка Тела Запроса (исправляет 'outfit is not defined')
    const { date, outfit, gender } = req.body || {};
    if (!date || !outfit || !gender) return res.status(400).json({ error:"Не хватает полей (date, outfit, gender)" });

    // 3. Проверка Даты
    const today = ymdZurich();
    if (date !== today) return res.status(400).json({ error:`Картинка доступна только на сегодня: ${today}` });

    // 4. Проверка Кэша
    const cached = await sql`
      SELECT image_base64 FROM user_calendar
      WHERE vk_user_id=${vkUserId} AND date=${today} AND image_generated = TRUE
      LIMIT 1
    `;
    if (cached.rows.length && cached.rows[0].image_base64){
      return res.status(200).json({ image_base64: cached.rows[0].image_base64, cached:true });
    }

    // 5. Гарантия Записи
    await sql`
      INSERT INTO user_calendar (vk_user_id,date,mood,gender,outfit,confirmed,locked_until,image_generated)
      VALUES (${vkUserId}, ${today}, ${"—"}, ${gender}, ${outfit}, FALSE, NULL, FALSE)
      ON CONFLICT (vk_user_id,date) DO NOTHING
    `;
    // --- КОНЕЦ: ПОЛНЫЙ БЛОК ПРОВЕРОК ---


    // --- НАЧАЛО: ЛОГИКА DEZGO FLUX (ИСПРАВЛЕНО) ---
    
    const prompt = buildPrompt({ outfit, gender });

    // ИСПРАВЛЕНИЕ: 'response_format: "base64"' убран
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
        // Этот заголовок говорит Dezgo, что мы ждем JSON, а не PNG
        "Accept": "application/json" 
      },
      body: JSON.stringify(payload)
    });

    if (!resp.ok) {
      const errDetails = await resp.json().catch(() => resp.text());
      return res.status(resp.status).json({ error:`Dezgo FLUX API ${resp.status}`, details: errDetails });
    }

    // Теперь 'resp.json()' сработает, т.к. Dezgo вернет JSON
    const data = await resp.json();
    const b64 = data.image; // 'image' - это поле с base64

    if (!b64) {
      return res.status(500).json({ error:"Dezgo FLUX: нет 'image' (base64) в ответе", details: JSON.stringify(data).slice(0,600) });
    }
    
    // --- КОНЕЦ: ЛОГИКА DEZGO FLUX ---

    // Сохранение в SQL
    await sql`
      UPDATE user_calendar
      SET image_base64=${b64}, image_generated=TRUE
      WHERE vk_user_id=${vkUserId} AND date=${today}
    `;
    return res.status(200).json({ image_base64: b64 });

  }catch(e){
    console.error(e);
    // Ошибка 'Unexpected token' 'PNG' больше не должна здесь появляться
    return res.status(500).json({ error:e.message });
  }
}
