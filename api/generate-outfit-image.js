// /api/generate-outfit-image.js
import { sql } from "@vercel/postgres";

export const config = { api: { bodyParser: { sizeLimit: "1mb" } } };

// --- Новые константы для Dezgo ---
const DEZGO_KEY = process.env.DEZGO_API_KEY;

// --- Твои старые функции (без изменений) ---
function parseCookies(req){/*...твой код...*/}
function ymdZurich(d=new Date()){/*...твой код...*/}
function buildPrompt({ outfit, gender }){/*...твой код...*/}

export default async function handler(req,res){
  try{
    if (req.method !== "POST") return res.status(405).json({ error:"Method Not Allowed" });
    if (!DEZGO_KEY) return res.status(500).json({ error:"DEZGO_API_KEY не задан" });

    // ... (твой код проверки cookies, vkUserId и т.д.) ...
    // ... (твой код проверки req.body) ...
    // ... (твой код проверки кэша в sql) ...
    // ... (твой код INSERT ... ON CONFLICT) ...


    // --- НАЧАЛО: ЛОГИКА DEZGO (вместо LaoZhang) ---
    
    const prompt = buildPrompt({ outfit, gender });

    // API Dezgo - простой и синхронный
    const payload = {
      prompt: prompt,
      model: "epic_realism", // Выбери модель на их сайте. 'epic_realism' хорош для людей
      width: 512,
      height: 512,
      response_format: "base64" // Сразу просим base64
    };

    const resp = await fetch("https://api.dezgo.com/text2image", {
      method: "POST",
      headers: {
        "X-Dezgo-Key": DEZGO_KEY,
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (!resp.ok) {
      // Dezgo обычно возвращает ошибки в JSON
      const errDetails = await resp.json().catch(() => resp.text());
      return res.status(resp.status).json({ error:`Dezgo API ${resp.status}`, details: errDetails });
    }

    // Dezgo возвращает JSON, где b64 лежит в поле 'image'
    // { "image": "iVBORw0KGgo...", "seed": 123 }
    const data = await resp.json();
    const b64 = data.image;

    if (!b64) {
      return res.status(500).json({ error:"Dezgo: нет 'image' (base64) в ответе", details: JSON.stringify(data).slice(0,600) });
    }
    
    // --- КОНЕЦ: ЛОГИКА DEZGO ---

    // Твой старый код для сохранения в SQL
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
