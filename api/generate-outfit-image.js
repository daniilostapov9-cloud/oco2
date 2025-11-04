// /api/generate-outfit-image.js
import { sql } from "@vercel/postgres";

export const config = { api: { bodyParser: { sizeLimit: "1mb" } } };

const DEZGO_KEY  = process.env.DEZGO_API_KEY;
const GEMINI_KEY = process.env.GEMINI_API_KEY;

// === используем ту же модель и тот же формат вызова, что и в твоём generate-outfit.js ===
const API_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent";

// ---------------- utils ----------------
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

// ---------------- Gemini (та же модель) ----------------
function systemInstruction() {
  return `You are a translator-normalizer for AI image prompts.

INPUT:
- gender_ru: "парень" or "девушка"
- outfit_ru_raw: free-form outfit description in Russian.

TASK:
Return ONLY valid JSON with this schema (no extra text):
{
  "gender_en": "male" | "female",
  "outfit_en": "comma-separated, short, lowercase clothing/style attributes in English",
  "outfit_ru": "comma-separated, short, lowercase clothing/style attributes in Russian"
}

Rules:
- gender_en must be exactly "male" or "female".
- Attributes are terse nouns/adjectives, no verbs/sentences (e.g., "black t-shirt, blue jeans, white sneakers, leather jacket").
- Keep brands only if present. Replace NSFW with safe generic clothing.`;
}

async function callGeminiJSON(userText){
  if (!GEMINI_KEY) throw new Error("GEMINI_API_KEY не задан");

  const payload = {
    contents: [{ role: "user", parts: [{ text: userText }]}],
    systemInstruction: { parts: [{ text: systemInstruction() }] },
  };

  const r = await fetch(`${API_URL}?key=${encodeURIComponent(GEMINI_KEY)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const b = await r.text().catch(()=> "");
    throw new Error(`Google API ${r.status}: ${b.slice(0, 300)}`);
  }
  const j = await r.json();
  const raw = j?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  if (!raw) throw new Error("Gemini: пустой ответ");
  // Пытаемся распарсить JSON. Если модель прислала текст с подсветкой — выщипываем {...}
  try {
    return JSON.parse(raw);
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("Gemini: не удалось распарсить JSON");
    return JSON.parse(m[0]);
  }
}

async function translateWithGemini({ genderRu, outfitRu }){
  try{
    const userText =
`gender_ru: ${String(genderRu||"").trim()}
outfit_ru_raw: ${String(outfitRu||"").trim()}`;
    const parsed = await callGeminiJSON(userText);

    const gender_en = (parsed.gender_en==="female"||parsed.gender_en==="male")
      ? parsed.gender_en
      : simpleGenderToEn(genderRu);

    const outfit_en = String(parsed.outfit_en||"").trim() || String(outfitRu||"").trim().toLowerCase();
    const outfit_ru = String(parsed.outfit_ru||"").trim() || String(outfitRu||"").trim().toLowerCase();

    return { gender_en, outfit_en, outfit_ru };
  }catch(e){
    // надёжный фоллбек без Gemini (на всякий случай)
    return {
      gender_en: simpleGenderToEn(genderRu),
      outfit_ru: String(outfitRu||"").trim().toLowerCase(),
      outfit_en: String(outfitRu||"").trim().toLowerCase(),
      _fallback: true
    };
  }
}

// ---------------- Dezgo prompt ----------------
function buildPrompt({ outfit_en, gender_en, alsoRu }){
  const style  = "pixel art, crisp sprite, full figure, simple studio background, no text, clean palette.";
  const gender = gender_en === "female" ? "female" : "male";
  const ruNote = alsoRu ? ` // ru: ${alsoRu}` : "";
  return `full-body ${gender} character wearing ${outfit_en}. ${style}${ruNote}`;
}

// ---------------- handler ----------------
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

    // кэш
    const cached = await sql`
      SELECT image_base64 FROM user_calendar
       WHERE vk_user_id=${vkUserId} AND date=${today} AND image_generated = TRUE
       LIMIT 1
    `;
    if (cached.rows.length && cached.rows[0].image_base64){
      return res.status(200).json({ image_base64: cached.rows[0].image_base64, cached:true });
    }

    // гарантируем строку дня
    await sql`
      INSERT INTO user_calendar (vk_user_id,date,mood,gender,outfit,confirmed,locked_until,image_generated)
      VALUES (${vkUserId}, ${today}, ${"—"}, ${gender}, ${outfit}, FALSE, NULL, FALSE)
      ON CONFLICT (vk_user_id,date) DO NOTHING
    `;

    // перевод+нормализация (модель как в твоём коде)
    const norm = await translateWithGemini({
      genderRu: gender,
      outfitRu: outfit
    });

    // сборка промпта и вызов Dezgo
    const prompt = buildPrompt({
      outfit_en: norm.outfit_en,
      gender_en: norm.gender_en,
      alsoRu: norm.outfit_ru
    });

    const resp = await fetch("https://api.dezgo.com/text2image_flux", {
      method: "POST",
      headers: {
        "X-Dezgo-Key": DEZGO_KEY,
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify({ prompt, width: 1024, height: 1024 })
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
