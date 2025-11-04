// /api/generate-outfit-image.js
import { sql } from "@vercel/postgres";

export const config = { api: { bodyParser: { sizeLimit: "1mb" } } };

const DEZGO_KEY  = process.env.DEZGO_API_KEY;
const GEMINI_KEY = process.env.GEMINI_API_KEY;

// ----- utils -----
function parseCookies(req){
  const h = req.headers.cookie || "";
  return Object.fromEntries(
    h.split(";")
     .map(v=>v.trim().split("=").map(decodeURIComponent))
     .filter(p=>p[0])
  );
}

function ymdZurich(d=new Date()){
  const p = new Intl.DateTimeFormat("en-CA",{
    timeZone:"Europe/Zurich",year:"numeric",month:"2-digit",day:"2-digit"
  }).formatToParts(d).reduce((a,x)=>(a[x.type]=x.value,a),{});
  return `${p.year}-${p.month}-${p.day}`;
}

function simpleGenderToEn(rusGenderText=""){
  const s = (rusGenderText||"").toLowerCase();
  if (/(девуш|жен|girl|female|f)\b/.test(s)) return "female";
  if (/(парн|муж|boy|male|m)\b/.test(s))     return "male";
  return "male";
}

// ----- Gemini -----
const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
// Попробуем несколько моделей по очереди:
const MODEL_CANDIDATES = [
  "gemini-1.5-flash-8b",
  "gemini-1.5-flash-latest",
  "gemini-1.5-flash",
  "gemini-1.5-pro-latest",
  "gemini-1.5-pro",
  "gemini-pro"
];

async function callGemini(promptText){
  if (!GEMINI_KEY) throw Object.assign(new Error("Gemini key missing"), { code: "NO_KEY" });

  const body = {
    contents: [{ role: "user", parts: [{ text: promptText }]}],
    generationConfig: {
      temperature: 0.1,
      topP: 0.2,
      topK: 1,
      maxOutputTokens: 256,
      responseMimeType: "application/json"
    }
  };

  let lastErr;
  for (const model of MODEL_CANDIDATES){
    try{
      const resp = await fetch(`${GEMINI_ENDPOINT}/${model}:generateContent?key=${encodeURIComponent(GEMINI_KEY)}`,{
        method:"POST",
        headers:{ "Content-Type":"application/json" },
        body: JSON.stringify(body)
      });
      if (!resp.ok){
        const text = await resp.text().catch(()=> "");
        // если именно 404 — пробуем следующую модель
        if (resp.status===404) { lastErr = new Error(`Gemini 404 on ${model}: ${text?.slice(0,300)}`); continue; }
        throw new Error(`Gemini ${resp.status} on ${model}: ${text?.slice(0,300)}`);
      }
      const data = await resp.json();
      const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
      return { model, raw };
    }catch(e){
      lastErr = e;
      // пробуем следующую
      continue;
    }
  }
  throw lastErr || new Error("Gemini: no models worked");
}

async function translateWithGemini({ genderRu, outfitRu }){
  // Fallback, если нет ключа
  if (!GEMINI_KEY) {
    return {
      gender_en: simpleGenderToEn(genderRu),
      outfit_ru: (outfitRu||"").trim().toLowerCase(),
      outfit_en: (outfitRu||"").trim().toLowerCase()
    };
  }

  const systemInstruction =
`You are a translator and normalizer for AI image prompts.
Input: gender in Russian ("парень" or "девушка") and outfit description in Russian.

Output ONLY valid JSON:
{
  "gender_en": "male" | "female",
  "outfit_en": "comma-separated, short, lowercase clothing/style attributes in English",
  "outfit_ru": "comma-separated, short, lowercase clothing/style attributes in Russian"
}

Rules:
- gender_en must be "male" or "female".
- Terse attributes (e.g., "black t-shirt, blue jeans, white sneakers, leather jacket").
- No verbs/sentences. No brands unless present. No NSFW; replace with safe generic terms.
`;

  const userContent =
`gender_ru: ${String(genderRu||"").trim()}
outfit_ru_raw: ${String(outfitRu||"").trim()}`;

  const { raw, model } = await callGemini(systemInstruction + "\n---\n" + userContent);

  let parsed;
  try{
    parsed = JSON.parse(raw);
  }catch{
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) throw new Error(`Gemini (${model}) JSON parse error: ${raw.slice(0,200)}`);
    parsed = JSON.parse(m[0]);
  }

  const gender_en = (parsed.gender_en==="female"||parsed.gender_en==="male")
    ? parsed.gender_en
    : simpleGenderToEn(genderRu);

  const outfit_en = String(parsed.outfit_en||"").trim() || String(outfitRu||"").trim().toLowerCase();
  const outfit_ru = String(parsed.outfit_ru||"").trim() || String(outfitRu||"").trim().toLowerCase();

  return { gender_en, outfit_en, outfit_ru };
}

// ----- Prompt for Dezgo -----
function buildPrompt({ outfit_en, gender_en, alsoRu }){
  const style  = "pixel art, crisp sprite, full figure, simple studio background, no text, clean palette.";
  const gender = gender_en === "female" ? "female" : "male";
  const ruNote = alsoRu ? ` // ru: ${alsoRu}` : "";
  return `full-body ${gender} character wearing ${outfit_en}. ${style}${ruNote}`;
}

// ----- Handler -----
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

    const cached = await sql`
      SELECT image_base64 FROM user_calendar
      WHERE vk_user_id=${vkUserId} AND date=${today} AND image_generated = TRUE
      LIMIT 1
    `;
    if (cached.rows.length && cached.rows[0].image_base64){
      return res.status(200).json({ image_base64: cached.rows[0].image_base64, cached:true });
    }

    await sql`
      INSERT INTO user_calendar (vk_user_id,date,mood,gender,outfit,confirmed,locked_until,image_generated)
      VALUES (${vkUserId}, ${today}, ${"—"}, ${gender}, ${outfit}, FALSE, NULL, FALSE)
      ON CONFLICT (vk_user_id,date) DO NOTHING
    `;

    const norm = await translateWithGemini({ genderRu: gender, outfitRu: outfit });

    const prompt = buildPrompt({
      outfit_en: norm.outfit_en,
      gender_en: norm.gender_en,
      alsoRu: norm.outfit_ru
    });

    const payload = { prompt, width: 1024, height: 1024 };

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

    const buffer = await resp.arrayBuffer();
    const b64 = Buffer.from(buffer).toString("base64");
    if (!b64) return res.status(500).json({ error:"Dezgo FLUX: не удалось конвертировать PNG в b64" });

    await sql`
      UPDATE user_calendar
      SET image_base64=${b64}, image_generated=TRUE
      WHERE vk_user_id=${vkUserId} AND date=${today}
    `;

    return res.status(200).json({
      image_base64: b64,
      meta: {
        gender_en: norm.gender_en,
        outfit_en: norm.outfit_en,
        outfit_ru: norm.outfit_ru
      }
    });

  }catch(e){
    console.error(e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
