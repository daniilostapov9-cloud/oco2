// /api/generate-outfit-image.js
import { sql } from "@vercel/postgres";

export const config = { api: { bodyParser: { sizeLimit: "1mb" } } };

const NOVITA_API_KEY = process.env.NOVITA_API_KEY;
const NOVITA_MODEL = process.env.NOVITA_MODEL || "sd_xl_base_1.0.safetensors"; // из доки Novita (SDXL)
const TXT2IMG_URL = "https://api.novita.ai/v3/async/txt2img";
const TASK_RESULT_URL = "https://api.novita.ai/v3/async/task-result";

function parseCookies(req) {
  const h = req.headers.cookie || "";
  return Object.fromEntries(
    h.split(";").map(v => v.trim().split("=").map(decodeURIComponent)).filter(p => p[0])
  );
}
function ymdZurich(d = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Zurich", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(d).reduce((a, p) => ((a[p.type] = p.value), a), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function buildPrompt({ outfit, gender }) {
  const prefix = `Generate me pixel person with description like in the text: `;
  const style  = ` Pixel art, clean palette, crisp sprite, full figure, simple studio background, no text.`;
  return `${prefix}"${outfit}" (gender: ${gender}).${style}`;
}

async function fetchAsBase64(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch image ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  return buf.toString("base64");
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });
    if (!NOVITA_API_KEY) return res.status(500).json({ error: "NOVITA_API_KEY не задан" });

    const cookies  = parseCookies(req);
    const vkToken  = cookies["vk_id_token"];
    const vkUserId = cookies["vk_user_id"];
    if (!vkToken || !vkUserId) return res.status(401).json({ error: "Требуется авторизация" });

    const { date, outfit, gender } = req.body || {};
    if (!date || !outfit || !gender) return res.status(400).json({ error: "Не хватает полей (date, outfit, gender)" });

    const today = ymdZurich();
    if (date !== today) return res.status(400).json({ error: `Картинка доступна только на сегодня: ${today}` });

    // 0) кэш на сегодня
    const cached = await sql`
      SELECT image_base64 FROM user_calendar
      WHERE vk_user_id=${vkUserId} AND date=${today} AND image_generated = TRUE
      LIMIT 1
    `;
    if (cached.rows.length && cached.rows[0].image_base64) {
      return res.status(200).json({ image_base64: cached.rows[0].image_base64, cached: true });
    }

    // 1) гарантируем запись на сегодня (для привязки кэша)
    await sql`
      INSERT INTO user_calendar (vk_user_id,date,mood,gender,outfit,confirmed,locked_until,image_generated)
      VALUES (${vkUserId}, ${today}, ${"—"}, ${gender}, ${outfit}, FALSE, NULL, FALSE)
      ON CONFLICT (vk_user_id,date) DO NOTHING
    `;

    // 2) формируем промпт и отправляем в Novita txt2img
    const prompt = buildPrompt({ outfit, gender });
    const payload = {
      extra: {
        response_image_type: "png" // png/webp/jpeg
      },
      request: {
        model_name: NOVITA_MODEL,
        prompt,
        width: 512,
        height: 512,
        image_num: 1,
        steps: 5,
        guidance_scale: 3.5,
        sampler_name: "Euler a",     // из их списка
        seed: -1
      }
    };

    const headers = {
      "Authorization": `Bearer ${NOVITA_API_KEY}`,
      "Content-Type": "application/json"
    };

    const submit = await fetch(TXT2IMG_URL, { method: "POST", headers, body: JSON.stringify(payload) });
    const submitText = await submit.text();
    if (!submit.ok) {
      return res.status(submit.status).json({ error: `Novita txt2img ${submit.status}`, details: submitText.slice(0, 600) });
    }
    let submitJson;
    try { submitJson = JSON.parse(submitText); } catch { return res.status(500).json({ error: "Novita txt2img: invalid JSON", details: submitText.slice(0,300) }); }
    const taskId = submitJson?.task_id;
    if (!taskId) return res.status(500).json({ error: "Novita: task_id не вернулся" });

    // 3) поллим результат
    const deadline = Date.now() + 60_000; // 60 сек
    let imageUrl = null, lastPayload = null;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 1200));
      const qs = new URLSearchParams({ task_id: taskId }).toString();
      const st = await fetch(`${TASK_RESULT_URL}?${qs}`, { headers: { Authorization: `Bearer ${NOVITA_API_KEY}` } });
      const body = await st.text();
      if (!st.ok) { lastPayload = body; continue; }
      let j; try { j = JSON.parse(body); } catch { lastPayload = body; continue; }

      const status = (j?.task?.status || "").toString();
      if (status === "TASK_STATUS_SUCCEED") {
        imageUrl = j?.images?.[0]?.image_url;
        break;
      }
      if (status === "TASK_STATUS_FAILED" || status === "TASK_STATUS_ERROR") {
        return res.status(500).json({ error: "Novita task failed", details: body.slice(0, 600) });
      }
      lastPayload = body;
    }
    if (!imageUrl) {
      return res.status(504).json({ error: "Novita task timeout", details: (lastPayload || "").slice(0, 600) });
    }

    // 4) скачиваем PNG и конвертим в base64
    const b64 = await fetchAsBase64(imageUrl);

    // 5) кэшируем и отдаём
    await sql`
      UPDATE user_calendar
      SET image_base64=${b64}, image_generated=TRUE
      WHERE vk_user_id=${vkUserId} AND date=${today}
    `;
    return res.status(200).json({ image_base64: b64 });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
}
