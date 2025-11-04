// /api/generate-outfit-image.js
import { sql } from "@vercel/postgres";

/**
 * Настройки
 */
export const config = { api: { bodyParser: { sizeLimit: "1mb" } } };

const DEZGO_KEY  = process.env.DEZGO_API_KEY;
const GEMINI_KEY = process.env.GEMINI_API_KEY; // <= добавили

/**
 * Утилиты
 */
// --- УБЕДИСЬ, ЧТО ЭТА ФУНКЦИЯ СКОПИРОВАНА ВЕРНО ---
function parseCookies(req){
  const h = req.headers.cookie || "";
  // ОШИБКА РАНЕЕ БЫЛА: отсутствовал return
  return Object.fromEntries(
    h.split(";")
     .map(v=>v.trim().split("=").map(decodeURIComponent))
     .filter(p=>p[0])
  );
}
// --- КОНЕЦ ФУНКЦИИ ---

function ymdZurich(d=new Date()){
  const p = new Intl.DateTimeFormat("en-CA",{
    timeZone:"Europe/Zurich",year:"numeric",month:"2-digit",day:"2-digit"
  }).formatToParts(d).reduce((a,x)=>(a[x.type]=x.value,a),{});
  return `${p.year}-${p.month}-${p.day}`;
}

/**
 * Нормализация пола (fallback без Gemini)
 */
function simpleGenderToEn(rusGenderText=""){
  const s = (rusGenderText||"").toLowerCase();
  if (/(девуш|жен|girl|female|f)\b/.test(s)) return "female";
  if (/(парн|муж|boy|male|m)\b/.test(s))     return "male";
  // дефолт — male (чтобы избежать андрогинности в большинстве моделей)
  return "male";
}

/**
 * Вызов Gemini для перевода и нормализации.
 * Возвращает структуру:
 * {
 *   gender_en: "male" | "female",
 *   outfit_en: "t-shirt, blue jeans, white sneakers",
 *   outfit_ru: "футболка, синие джинсы, белые кроссовки"
 * }
 */
async function translateWithGemini({ genderRu, outfitRu }){
  // Если нет ключа — делаем безопасный fallback
  if (!GEMINI_KEY) {
    return {
      gender_en: simpleGenderToEn(genderRu),
      // максимально простой фоллбек: отдадим исходник как ru, а en — через наивную трансформацию
      outfit_ru: (outfitRu||"").trim(),
      outfit_en: (outfitRu||"")
        .replace(/пар[а-я]*|девуш[а-я]*/gi,"")     // убрать слова про пол из описания
        .replace(/[А-ЯЁ]/g, m => m.toLowerCase())  // к нижнему регистру
        .trim()
    };
  }

  // Подготовим строгую инструкцию с требованием JSON-вывода
  const systemInstruction =
`You are a translator and normalizer for AI image prompts.
Input: gender in Russian (e.g., "парень" or "девушка") and an outfit description in Russian.
Task: Translate and normalize for a text-to-image model that expects concise English attributes and an explicit gender.

Output ONLY valid JSON with this exact schema (no extra text):
{
  "gender_en": "male" | "female",
  "outfit_en": "comma-separated, short, lowercase clothing and style attributes in English",
  "outfit_ru": "comma-separated, short, lowercase clothing and style attributes in Russian"
}

Rules:
- gender_en must be one of: "male", "female".
- Keep attributes terse (e.g., "black t-shirt, blue jeans, white sneakers, leather jacket").
- Avoid verbs, pronouns, or full sentences.
- No brand names unless present in the Russian text.
- No NSFW content; if present, replace with safe generic clothing terms.
`;

  const userContent =
`gender_ru: ${String(genderRu||"").trim()}
outfit_ru_raw: ${String(outfitRu||"").trim()}`;

  // Gemini v1beta REST (response as JSON)
  const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent";

  const body = {
    contents: [{ role: "user", parts: [{ text: systemInstruction + "\n---\n" + userContent }]}],
    generationConfig: {
      temperature: 0.1,
      topP: 0.2,
      topK: 1,
      maxOutputTokens: 256,
      // Просим именно JSON на выходе
      responseMimeType: "application/json"
    }
  };

  const resp = await fetch(`${url}?key=${encodeURIComponent(GEMINI_KEY)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(()=> "");
    throw new Error(`Gemini API ${resp.status}: ${txt?.slice(0,300)}`);
  }

  const data = await resp.json();

  // Попытка вытащить JSON-строку из ответа Gemini
  const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // На всякий случай попробуем выщипнуть {...} из текста
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("Gemini: не удалось распарсить JSON ответ");
    parsed = JSON.parse(m[0]);
  }

  // Валидация и подстраховка
  const gender_en = (parsed.gender_en==="female"||parsed.gender_en==="male")
    ? parsed.gender_en
    : simpleGenderToEn(genderRu);

  const outfit_en = String(parsed.outfit_en||"").trim();
  const outfit_ru = String(parsed.outfit_ru||"").trim();

  if (!outfit_en) {
    // Фоллбек: если Gemini вернул пусто — используем сырое RU как EN
    return { gender_en, outfit_en: String(outfitRu||"").trim().toLowerCase(), outfit_ru: String(outfitRu||"").trim().toLowerCase() };
  }
  return { gender_en, outfit_en, outfit_ru };
}

/**
 * Сборка промпта для Dezgo (FLUX)
 * Используем только английские токены + жёсткий стиль пиксель-арта
 */
function buildPrompt({ outfit_en, gender_en, alsoRu }){
  const style  = "pixel art, crisp sprite, full figure, simple studio background, no text, clean palette.";
  // Подсказка полу для моделей (важно указать явно)
  const gender = gender_en === "female" ? "female" : "male";

  // Иногда полезно сохранить русские атрибуты как комментарий (модели игнорируют, но тебе это может помочь в логах)
  const ruNote = alsoRu ? ` // ru: ${alsoRu}` : "";

  return `full-body ${gender} character wearing ${outfit_en}. ${style}${ruNote}`;
}

/**
 * Основной обработчик
 */
export default async function handler(req,res){
  try{
    if (req.method !== "POST") return res.status(405).json({ error:"Method Not Allowed" });
    if (!DEZGO_KEY) return res.status(500).json({ error:"DEZGO_API_KEY не задан" });

    // 1) Авторизация по cookie
    const cookies  = parseCookies(req);
    const vkToken  = cookies["vk_id_token"];
    const vkUserId = cookies["vk_user_id"];
    if (!vkToken || !vkUserId) return res.status(401).json({ error:"Требуется авторизация" });

    // 2) Тело запроса (принимаем русские поля как есть)
    const { date, outfit, gender } = req.body || {};
    if (!date || !outfit || !gender) return res.status(400).json({ error:"Не хватает полей (date, outfit, gender)" });

    // 3) Проверка даты (Europe/Zurich)
    const today = ymdZurich();
    if (date !== today) return res.status(400).json({ error:`Картинка доступна только на сегодня: ${today}` });

    // 4) Кэш
    const cached = await sql`
      SELECT image_base64 FROM user_calendar
       WHERE vk_user_id=${vkUserId} AND date=${today} AND image_generated = TRUE
       LIMIT 1
    `;
    if (cached.rows.length && cached.rows[0].image_base64){
      return res.status(200).json({ image_base64: cached.rows[0].image_base64, cached:true });
    }

    // 5) Гарантируем запись строки дня
    await sql`
      INSERT INTO user_calendar (vk_user_id,date,mood,gender,outfit,confirmed,locked_until,image_generated)
      VALUES (${vkUserId}, ${today}, ${"—"}, ${gender}, ${outfit}, FALSE, NULL, FALSE)
      ON CONFLICT (vk_user_id,date) DO NOTHING
    `;

    // --- ПЕРЕВОД И НОРМАЛИЗАЦИЯ С ПОМОЩЬЮ GEMINI ---
    const norm = await translateWithGemini({
      genderRu: gender,   // ожидаем "парень" или "девушка"
      outfitRu: outfit    // описание одежды по-русски
    });
    // console.log("Gemini normalized:", norm);

    // --- СБОРКА ПРОМПТА ДЛЯ DEZGO ---
    const prompt = buildPrompt({
      outfit_en: norm.outfit_en,
      gender_en: norm.gender_en,
      alsoRu: norm.outfit_ru
    });

    // --- ВЫЗОВ DEZGO FLUX ---
    const payload = {
      prompt,
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

    // PNG -> base64
    const buffer = await resp.arrayBuffer();
    const b64 = Buffer.from(buffer).toString("base64");
    if (!b64) return res.status(500).json({ error:"Dezgo FLUX: не удалось конвертировать PNG в b64" });

    // --- СОХРАНЕНИЕ В SQL ---
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
