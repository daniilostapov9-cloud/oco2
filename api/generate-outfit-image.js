// /api/generate-outfit-image.js
// Novita AI: 1 картинка в день + кэш. Гибкая конфигурация URL, подробные ошибки.
import { sql } from "@vercel/postgres";

export const config = { api: { bodyParser: { sizeLimit: "1mb" } } };

const NOVITA_API_KEY  = process.env.NOVITA_API_KEY;
const NOVITA_IMAGE_URL = process.env.NOVITA_IMAGE_URL || ""; // если не задан, попробуем кандидаты ниже

// типичные пути Novita, код переберёт их по очереди, пока один не сработает
const CANDIDATE_ENDPOINTS = [
  "https://api.novita.ai/v3/text-to-image",          // sync b64
  "https://api.novita.ai/v3/async/text-to-image",    // async -> task
  "https://api.novita.ai/v3/images/generate",        // иной вариант
  "https://api.novita.ai/v3/generate/text-to-image",
  "https://api.novita.ai/v3/openai/images/generations" // openai-совместимый
];

function buildPrompt({ outfit, gender }) {
  const prefix = `Generate me pixel person with description like in the text: `;
  const style  = ` Pixel art, clean palette, crisp sprite, full figure, simple studio background, no text.`;
  return `${prefix}"${outfit}" (gender: ${gender}).${style}`;
}

function parseCookies(req){
  const h = req.headers.cookie || "";
  return Object.fromEntries(
    h.split(";").map(v => v.trim().split("=").map(decodeURIComponent)).filter(p => p[0])
  );
}
function ymdZurich(d=new Date()){
  const parts = new Intl.DateTimeFormat("en-CA",{ timeZone:"Europe/Zurich", year:"numeric", month:"2-digit", day:"2-digit"})
    .formatToParts(d).reduce((a,p)=>(a[p.type]=p.value,a),{});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

async function trySync(url, payload, headers){
  const r = await fetch(url, { method:"POST", headers, body: JSON.stringify(payload) });
  const text = await r.text();
  if (!r.ok) return { ok:false, status:r.status, text };
  // разные возможные формы ответа
  try{
    const j = JSON.parse(text);
    const b64 = j?.images?.[0]?.b64_json || j?.images?.[0]?.base64 || j?.data?.[0]?.b64 || j?.data?.[0]?.base64;
    if (b64) return { ok:true, image:b64 };
    // иногда sync-роут возвращает task_id — тогда вернём специальный маркер
    const task = j?.task_id || j?.id || j?.job_id;
    if (task) return { ok:false, status:202, task };
    return { ok:false, status:500, text:"no image field in sync response" };
  }catch{
    return { ok:false, status:500, text:"invalid JSON from Novita: " + text.slice(0,300) };
  }
}

async function pollTask(statusUrl, headers, taskId){
  const url = statusUrl.replace(/\/tasks\/[^/]*$/,""); // страхуемся от случайных форм
  const taskEndpoint = statusUrl.includes("/tasks/") ? statusUrl : `https://api.novita.ai/v3/tasks/${taskId}`;
  const start = Date.now(), deadline = start + 60_000;
  while (Date.now() < deadline){
    await new Promise(r => setTimeout(r, 1200));
    const r = await fetch(taskEndpoint, { headers });
    const text = await r.text();
    if (!r.ok) continue;
    try{
      const j = JSON.parse(text);
      const st = (j?.status || j?.state || "").toLowerCase();
      if (["completed","succeeded","success"].includes(st)){
        const b64 = j?.images?.[0]?.b64_json || j?.images?.[0]?.base64 || j?.result?.[0]?.b64 || j?.result?.[0]?.base64;
        if (b64) return { ok:true, image:b64 };
        return { ok:false, status:500, text:"no image in task" };
      }
      if (["failed","error"].includes(st)) {
        return { ok:false, status:500, text: j?.message || j?.error || "task failed" };
      }
    }catch{ /* продолжим поллить */ }
  }
  return { ok:false, status:504, text:"poll timeout" };
}

export default async function handler(req, res){
  try{
    if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });
    if (!NOVITA_API_KEY) return res.status(500).json({ error: "NOVITA_API_KEY не задан" });

    const cookies  = parseCookies(req);
    const vkToken  = cookies["vk_id_token"];
    const vkUserId = cookies["vk_user_id"];
    if (!vkToken || !vkUserId) return res.status(401).json({ error: "Требуется авторизация" });

    const { date, outfit, gender } = req.body || {};
    if (!date || !outfit || !gender) return res.status(400).json({ error: "Не хватает полей (date, outfit, gender)" });

    const today = ymdZurich();
    if (date !== today) return res.status(400).json({ error:`Картинка доступна только на сегодня: ${today}` });

    // 0) Кэш сегодняшнего дня
    const cached = await sql`
      SELECT image_base64 FROM user_calendar
      WHERE vk_user_id=${vkUserId} AND date=${today} AND image_generated = TRUE
      LIMIT 1
    `;
    if (cached.rows.length && cached.rows[0].image_base64){
      return res.status(200).json({ image_base64: cached.rows[0].image_base64, cached:true });
    }

    // 1) гарантия записи на сегодня (для привязки кэша)
    await sql`
      INSERT INTO user_calendar (vk_user_id,date,mood,gender,outfit,confirmed,locked_until,image_generated)
      VALUES (${vkUserId}, ${today}, ${"—"}, ${gender}, ${outfit}, FALSE, NULL, FALSE)
      ON CONFLICT (vk_user_id,date) DO NOTHING
    `;

    // 2) подготовка запроса
    const prompt = buildPrompt({ outfit, gender });
    const payload = {
      prompt,
      width: 512, height: 512, steps: 5, guidance: 3.5,
      style_preset: "pixel-art"
    };
    const headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${NOVITA_API_KEY}`
    };

    // 3) выбираем список URL: либо заданный руками, либо пул кандидатов
    const endpoints = NOVITA_IMAGE_URL ? [NOVITA_IMAGE_URL] : CANDIDATE_ENDPOINTS;

    let lastErr = null, imageB64 = null;

    for (const ep of endpoints){
      // попробуем sync
      const sync = await trySync(ep, payload, headers);
      if (sync.ok){ imageB64 = sync.image; break; }
      if (sync.status === 202 && sync.task){
        // есть task_id — пробуем поллить универсальный /tasks/<id>
        const polled = await pollTask("https://api.novita.ai/v3/tasks/" + sync.task, headers, sync.task);
        if (polled.ok){ imageB64 = polled.image; break; }
        lastErr = polled;
        continue;
      }
      // если 404 — пробуем следующий кандидат
      lastErr = sync;
      if (sync.status === 404) continue;
      // если другая ошибка — тоже продолжим к следующему
    }

    if (!imageB64){
      const msg = lastErr ? `Novita API ${lastErr.status || "error"}: ${String(lastErr.text || "").slice(0,400)}` : "no endpoints worked";
      return res.status(502).json({ error: msg });
    }

    // 4) кэшируем результат на сегодня
    await sql`
      UPDATE user_calendar
      SET image_base64=${imageB64}, image_generated=TRUE
      WHERE vk_user_id=${vkUserId} AND date=${today}
    `;

    return res.status(200).json({ image_base64: imageB64 });
  }catch(e){
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
}
