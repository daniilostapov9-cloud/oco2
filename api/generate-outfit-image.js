// /api/generate-outfit-image.js
import { sql } from "@vercel/postgres";
import { GoogleGenerativeAI } from "@google/generative-ai";

export const config = { api: { bodyParser: { sizeLimit: "1mb" } } };

const DEZGO_KEY   = process.env.DEZGO_API_KEY;
const GEMINI_KEY  = process.env.GEMINI_API_KEY;

// ----------------- УТИЛИТЫ (старые + новые) -----------------
function parseCookies(req){
  const h = req.headers.cookie || "";
  return Object.fromEntries(h.split(";").map(v=>v.trim().split("=").map(decodeURIComponent)).filter(p=>p[0]));
}
function ymdZurich(d=new Date()){
  const p = new Intl.DateTimeFormat("en-CA",{ timeZone:"Europe/Zurich",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(d).reduce((a,x)=>(a[x.type]=x.value,a),{});
  return `${p.year}-${p.month}-${p.day}`;
}

// Простая эвристика на случай фоллбэка
function fallbackNormalize({ outfit, gender }){
  const txt = `${outfit || ""} ${gender || ""}`.toLowerCase();

  // Пол
  let gender_en = "unspecified";
  if (/(парень|мужчина|мужской|male|man|boy)/i.test(txt)) gender_en = "male";
  if (/(девушка|женщина|женский|female|woman|girl)/i.test(txt)) gender_en = "female";
  if (gender && /male|female/i.test(gender)) gender_en = gender.toLowerCase();

  // Разбиваем одежду по запятым/слэшам/точкам с запятой
  const parts = (outfit || "")
    .split(/[,;\/\n]+/).map(s => s.trim()).filter(Boolean);

  // Очень простой "перевод" — просто пробрасываем как en = ru,
  // чтобы не падало, если Gemini вдруг не доступен.
  const attributes = parts.map(ru => ({ ru, en: ru }));

  return { gender_en, attributes };
}

// Вызов Gemini: нормализуем пол и переводим атрибуты
async function analyzeWithGemini({ outfit, gender }){
  if (!GEMINI_KEY) {
    // Если ключа нет — жёстко фейлим, чтобы было видно проблему настройки
    throw new Error("GEMINI_API_KEY не задан");
  }

  const genAI = new GoogleGenerativeAI(GEMINI_KEY);
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

  // Просим строго JSON без пояснений
  const sys = [
    "Ты помощник по нормализации промптов для генерации изображений.",
    "Вход: свободный текст с описанием одежды на русском/английском + возможно указан пол ('парень','девушка', 'мужчина','женщина', male/female).",
    "Задача:",
    "1) Определи пол (если можно) и верни в виде 'male' или 'female'. Если пол не ясен, попытайся угадать по словам. Если совсем нельзя — верни 'unspecified'.",
    "2) Извлеки перечисление предметов одежды/атрибутов (не эмоции, не фон) и дай для каждого пару переводов: ru и en.",
    "3) Выведи СТРОГО валидный JSON без комментариев и без лишнего текста по схеме:",
    '{ "gender_en": "male|female|unspecified", "attributes": [ { "ru": "красная рубашка", "en": "red shirt" }, ... ] }',
    "Никаких пояснений, только JSON."
  ].join("\n");

  const user = [
    "Текст описания:",
    `Outfit: ${outfit || ""}`,
    `Gender (raw): ${gender || ""}`
  ].join("\n");

  const resp = await model.generateContent([{ role: "user", parts: [{ text: sys + "\n\n" + user }] }]);
  const raw = resp?.response?.text?.() || "";

  // Попытка парсинга JSON (может прийти с обрамляющими ```json)
  const jsonStr = raw.trim()
    .replace(/^```json/i, "")
    .replace(/^```/, "")
    .replace(/```$/, "")
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    // Если модель прислала невалид — фоллбэк
    parsed = fallbackNormalize({ outfit, gender });
  }

  // Санитация результата
  let gender_en = (parsed?.gender_en || "").toString().toLowerCase();
  if (!["male","female","unspecified"].includes(gender_en)) {
    gender_en = fallbackNormalize({ outfit, gender }).gender_en;
  }
  const attributes = Array.isArray(parsed?.attributes)
    ? parsed.attributes
        .map(x => ({ ru: (x?.ru || "").toString().trim(), en: (x?.en || "").toString().trim() }))
        .filter(x => x.ru || x.en)
    : fallbackNormalize({ outfit, gender }).attributes;

  return { gender_en, attributes };
}

// Построение промпта для Dezgo FLUX на основе структурированных данных
function buildPromptFromStructured({ attributes, gender_en }){
  // Список "en [ru]" — и Dezgo понимает англ, и вы видите русские атрибуты
  const details = attributes.map(a => {
    const en = a.en || a.ru || "";
    const ru = a.ru ? ` [${a.ru}]` : "";
    return `${en}${ru}`;
  }).join(", ");

  const prefix = `Generate me pixel person with description like in the text: `;
  const style  = ` Pixel art, clean palette, crisp sprite, full figure, simple studio background, no text.`;
  const g = gender_en && gender_en !== "unspecified" ? gender_en : "unspecified";
  return `${prefix}"${details}" (gender: ${g}).${style}`;
}

// ----------------- ОСНОВНОЙ ХЕНДЛЕР -----------------
export default async function handler(req,res){
  try{
    if (req.method !== "POST") return res.status(405).json({ error:"Method Not Allowed" });
    if (!DEZGO_KEY)  return res.status(500).json({ error:"DEZGO_API_KEY не задан" });
    if (!GEMINI_KEY) return res.status(500).json({ error:"GEMINI_API_KEY не задан" });

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

    // 4. Проверяем, не исчерпан ли уже лимит
    const limitCheck = await sql`
      SELECT image_generated FROM user_calendar
      WHERE vk_user_id=${vkUserId} AND date=${today}
      LIMIT 1
    `;
    if (limitCheck.rows.length && limitCheck.rows[0].image_generated === true){
      return res.status(429).json({ error: "Лимит на генерацию (1 в день) исчерпан" });
    }

    // 5. Гарантия Записи
    await sql`
      INSERT INTO user_calendar (vk_user_id,date,mood,gender,outfit,confirmed,locked_until)
      VALUES (${vkUserId}, ${today}, ${"—"}, ${gender}, ${outfit}, FALSE, NULL)
      ON CONFLICT (vk_user_id,date) DO NOTHING
    `;
    // --- КОНЕЦ ПРОВЕРОК ---

    // --- НОВОЕ: АНАЛИТИКА ТЕКСТА ЧЕРЕЗ GEMINI ---
    const { gender_en, attributes } = await analyzeWithGemini({ outfit, gender });

    // Если внезапно пусто — фоллбэк
    const normalized = (!attributes || attributes.length === 0)
      ? fallbackNormalize({ outfit, gender })
      : { gender_en, attributes };

    // --- ПОСТРОЕНИЕ ПРОМПТА ДЛЯ DEZGO ---
    const prompt = buildPromptFromStructured(normalized);

    // --- ВЫЗОВ DEZGO FLUX ---
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

    // Отмечаем лимит
    await sql`
      UPDATE user_calendar
      SET image_generated = TRUE
      WHERE vk_user_id=${vkUserId} AND date=${today}
    `;

    // Можно вернуть ещё и отладочную структуру нормализации (по желанию)
    return res.status(200).json({
      image_base64: b64,
      normalized: {
        gender_en: normalized.gender_en,
        attributes: normalized.attributes
      }
    });

  }catch(e){
    console.error(e);
    return res.status(500).json({ error:e.message });
  }
}
