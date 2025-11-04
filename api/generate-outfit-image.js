// /api/generate-outfit-image.js
import { sql } from "@vercel/postgres";

export const config = { api: { bodyParser: { sizeLimit: "1mb" } } };

// --- API Ключи (нужны оба) ---
const DEZGO_KEY = process.env.DEZGO_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY; // От AI Studio

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

// --- ИСПРАВЛЕННАЯ ФУНКЦИЯ ПЕРЕВОДЧИКА (AI Studio, v1 API) ---
async function translateToEnglish(text) {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY не задан для переводчика");

  // --- ИСПРАВЛЕНИЕ: Используем стабильный 'v1' API ---
  const url = `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash-latest:generateContent?key=${GEMINI_API_KEY}`;
  
  const payload = {
    // 'v1' API не использует 'systemInstruction', встраиваем инструкцию сюда
    "contents": [
      { 
        "role": "user",
        "parts": [{ "text": "You are an expert translator. Translate the following Russian text to English. Return ONLY the translated text, without any introductory phrases or quotation marks." }]
      },
      {
        "role": "model",
        "parts": [{ "text": "OK." }] // "Пример" для модели, чтобы она поняла формат
      },
      {
        "role": "user",
        "parts": [{ "text": text }] // Текст, который нужно перевести
      }
    ],
    "generationConfig": {
      "temperature": 0.1,
      "topP": 1,
      "topK": 1
    },
    "safetySettings": [
      { "category": "HARM_CATEGORY_HARASSMENT", "threshold": "BLOCK_NONE" },
      { "category": "HARM_CATEGORY_HATE_SPEECH", "threshold": "BLOCK_NONE" },
      { "category": "HARM_CATEGORY_SEXUALLY_EXPLICIT", "threshold": "BLOCK_NONE" },
      { "category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": "BLOCK_NONE" }
    ]
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!resp.ok) {
    // Эта ошибка расскажет нам, в чем дело (например, 'API key not valid')
    throw new Error(`Google Gemini API Error ${resp.status}: ${await resp.text()}`);
  }

  // Здесь была ошибка 'Unexpected token 'A''
  const data = await resp.json();

  if (!data.candidates || !data.candidates[0].content) {
    console.error("Gemini response was empty or blocked:", JSON.stringify(data));
    throw new Error("Gemini API Error: No content returned (check prompt or safety settings)");
  }
  
  return data.candidates[0].content.parts[0].text;
}
// --- КОНЕЦ ИСПРАВЛЕННОЙ ФУНКЦИИ ---


// --- "УМНЫЙ" ПРОМПТ (без изменений) ---
function buildPrompt({ outfit, gender }){
  const prefix = `A pixel art sprite of a ${gender}, full figure.`;
  const style  = `Pixel art, clean palette, crisp sprite, simple studio background, no text.`;
  const description = `The ${gender} is wearing: ${outfit}`;
  
  return `${prefix} ${style} ${description}`;
}

export default async function handler(req,res){
  try{
    if (req.method !== "POST") return res.status(405).json({ error:"Method NotAllowed" });
    if (!DEZGO_KEY) return res.status(500).json({ error:"DEZGO_KEY не задан" });
    if (!GEMINI_API_KEY) return res.status(500).json({ error:"GEMINI_API_KEY не задан" });

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

    // --- ШАГ 1: ПЕРЕВОД (через Gemini AI Studio) ---
    let englishOutfit;
    try {
      englishOutfit = await translateToEnglish(outfit); 
    } catch (e) {
      console.error(e);
      // Ошибка будет здесь, если что-то не так с ключом или моделью
      return res.status(500).json({ error: "Ошибка API Переводчика (Gemini)", details: e.message });
    }

    // --- ШАГ 2: ГЕНЕРАЦИЯ (с английским, через Dezgo) ---
    const prompt = buildPrompt({ outfit: englishOutfit, gender: gender });

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
    
    // Конвертируем PNG-ответ в b64
    const buffer = await resp.arrayBuffer();
    const b64 = Buffer.from(buffer).toString('base64');

    if (!b64) {
      return res.status(500).json({ error:"Dezgo FLUX: не удалось конвертировать PNG в b64" });
    }
    
    // --- ШАГ 3: Сохранение в SQL ---
    await sql`
      UPDATE user_calendar
      SET image_base64=${b64}, image_generated=TRUE
      WHERE vk_user_id=${vkUserId} AND date=${today}
    `;
    return res.status(200).json({ image_base64: b64 });

  }catch(e){
    console.error(e);
    // Сюда мы больше не должны попадать
    return res.status(500).json({ error:e.message });
  }
}
