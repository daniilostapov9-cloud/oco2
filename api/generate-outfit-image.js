// /api/generate-outfit-image.js
import { sql } from "@vercel/postgres";

export const config = { api: { bodyParser: { sizeLimit: "1mb" } } };

// --- Константа Dezgo (без изменений) ---
const DEZGO_KEY = process.env.DEZGO_API_KEY;

// --- Твои старые функции (без изменений) ---
function parseCookies(req){/*...твой код...*/}
function ymdZurich(d=new Date()){/*...твой код...*/}
function buildPrompt({ outfit, gender }){
  const prefix = `Generate me pixel person with description like in the text: `;
  const style  = ` Pixel art, clean palette, crisp sprite, full figure, simple studio background, no text.`;
  // ВНИМАНИЕ: 'outfit' здесь может содержать кириллицу
  return `${prefix}"${outfit}" (gender: ${gender}).${style}`;
}

export default async function handler(req,res){
  try{
    if (req.method !== "POST") return res.status(405).json({ error:"Method Not Allowed" });
    if (!DEZGO_KEY) return res.status(500).json({ error:"DEZGO_API_KEY не задан" });

    // ... (Твой код: parseCookies, vkUserId, vkToken) ...
    // ... (Твой код: извлечение date, outfit, gender из req.body) ...
    // ... (Твой код: проверка today, проверка кэша, INSERT в sql) ...
    
    // --- НАЧАЛО: ЛОГИКА DEZGO FLUX ---
    
    // ВНИМАНИЕ: Если 'outfit' русский, 'prompt' тоже будет с кириллицей
    const prompt = buildPrompt({ outfit, gender });

    const payload = {
      prompt: prompt,
      // 'model' убран, т.к. он в URL
      width: 1024,   // <-- ИЗМЕНЕНО
      height: 1024,  // <-- ИЗМЕНЕНО
      response_format: "base64"
    };

    const resp = await fetch("https://api.dezgo.com/text2image_flux", { // <-- ИЗМЕНЕНО
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

    const data = await resp.json();
    const b64 = data.image;

    if (!b64) {
      return res.status(500).json({ error:"Dezgo FLUX: нет 'image' (base64) в ответе", details: JSON.stringify(data).slice(0,600) });
    }
    
    // --- КОНЕЦ: ЛОГИКА DEZGO FLUX ---

    // ... (Твой код: UPDATE sql) ...
    
    return res.status(200).json({ image_base64: b64 });

  }catch(e){
    console.error(e);
    return res.status(500).json({ error:e.message });
  }
}
