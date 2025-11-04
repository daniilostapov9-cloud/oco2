// /api/generate-outfit-image.js
// Генерация пиксель-арта через Novita AI + кэш на сегодня.
// Требуется NOVITA_API_KEY в окружении.
// Поведение: 1 изображение в день на пользователя. Повторные вызовы -> мгновенно отдаем кэш.

import { sql } from "@vercel/postgres";

export const config = { api: { bodyParser: { sizeLimit: "1mb" } } };

const NOVITA_API_KEY = process.env.NOVITA_API_KEY;

// Настройки Novita (универсальные — под разные их эндпоинты)
const NOVITA_SYNC_URL = "https://api.novita.ai/v3/text-to-image";     // вариант, когда сервис отдает b64 сразу
const NOVITA_ASYNC_URL = "https://api.novita.ai/v3/async/text-to-image"; // вариант, когда сервис возвращает task_id
const NOVITA_TASK_URL = (taskId) => `https://api.novita.ai/v3/tasks/${taskId}`;

// Общий промпт: твоя формулировка на английском + текст образа на русском
function buildPrompt({ outfit, gender }) {
  const prefix = `Generate me pixel person with description like in the text: `;
  const style = ` Pixel art, clean palette, crisp sprite, full figure, simple studio background, no text.`;
  return `${prefix}"${outfit}" (gender: ${gender}).${style}`;
}

function parseCookies(req) {
  const h = req.headers.cookie || "";
  return Object.fromEntries(
    h
      .split(";")
      .map(v => v.trim().split("=").map(decodeURIComponent))
      .filter(p => p[0])
  );
}

function ymdZurich(d = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Zurich",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .formatToParts(d)
    .reduce((a, p) => ((a[p.type] = p.value), a), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });
    if (!NOVITA_API_KEY) return res.status(500).json({ error: "NOVITA_API_KEY не задан" });

    const cookies = parseCookies(req);
    const vkToken = cookies["vk_id_token"];
    const vkUserId = cookies["vk_user_id"];
    if (!vkToken || !vkUserId) return res.status(401).json({ error: "Требуется авторизация" });

    const { date, outfit, gender } = req.body || {};
    if (!date || !outfit || !gender) return res.status(400).json({ error: "Не хватает полей (date, outfit, gender)" });

    const today = ymdZurich();
    if (date !== today) return res.status(400).json({ error: `Картинка доступна только на сегодня: ${today}` });

    // 0) Если уже кэшировали картинку сегодня — сразу отдаем её (без вызова Novita).
    const cached = await sql`
      SELECT image_base64 FROM user_calendar
      WHERE vk_user_id = ${vkUserId} AND date = ${today} AND image_generated = TRUE
      LIMIT 1
    `;
    if (cached.rows.length && cached.rows[0].image_base64) {
      return res.status(200).json({ image_base64: cached.rows[0].image_base64, cached: true });
    }

    // 1) Если записи на сегодня нет — создадим её (или обновим) с текстом образа,
    //    чтобы связать кэш изображения с этим же днём.
    await sql`
      INSERT INTO user_calendar (vk_user_id, date, mood, gender, outfit, confirmed, locked_until, image_generated)
      VALUES (${vkUserId}, ${today}, ${"—"}, ${gender}, ${outfit}, FALSE, NULL, FALSE)
      ON CONFLICT (vk_user_id, date) DO UPDATE
      SET gender = EXCLUDED.gender,
          outfit = CASE WHEN user_calendar.outfit IS NULL OR user_calendar.outfit = '' THEN EXCLUDED.outfit ELSE user_calendar.outfit END
    `;

    // 2) Перед тем как реально дергать Novita — ещё раз проверим, вдруг параллельный запрос успел сгенерировать и записать картинку.
    const recheck = await sql`
      SELECT image_base64 FROM user_calendar
      WHERE vk_user_id = ${vkUserId} AND date = ${today} AND image_generated = TRUE
      LIMIT 1
    `;
    if (recheck.rows.length && recheck.rows[0].image_base64) {
      return res.status(200).json({ image_base64: recheck.rows[0].image_base64, cached: true });
    }

    // 3) Генерация через Novita (1 раз)
    const prompt = buildPrompt({ outfit, gender });

    // Попытаемся сначала "синхронный" эндпоинт (который отдаёт base64 сразу)
    const basePayload = {
      prompt,
      // Дешёвые параметры: маленькое разрешение и малые шаги — под пиксель-арт это ок.
      width: 512,
      height: 512,
      steps: 5,
      guidance: 3.5,
      // Можно указать конкретную модель, если в Novita требуется:
      // model: "flux-dev" // или "sdxl-turbo", "anything-pixel" — зависит от твоей выбранной модели в Novita
      // Доп. стили:
      style_preset: "pixel-art"
    };

    const commonHeaders = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${NOVITA_API_KEY}`,
    };

    let imageB64 = null;

    // 3a) SYNCHRONOUS attempt
    let resp = await fetch(NOVITA_SYNC_URL, {
      method: "POST",
      headers: commonHeaders,
      body: JSON.stringify(basePayload),
    });

    if (resp.status === 200) {
      const j = await resp.json();
      // Примеры возможных структур: { images: [{ b64_json: "..." }]} или { data: [{ b64: "..." }]}
      imageB64 =
        j?.images?.[0]?.b64_json ||
        j?.images?.[0]?.base64 ||
        j?.data?.[0]?.b64 ||
        j?.data?.[0]?.base64 ||
        null;
    }

    // 3b) ASYNC fallback (если синхронный не сработал/вернул не 200)
    if (!imageB64) {
      resp = await fetch(NOVITA_ASYNC_URL, {
        method: "POST",
        headers: commonHeaders,
        body: JSON.stringify(basePayload),
      });

      if (!resp.ok) {
        const txt = await resp.text();
        return res.status(resp.status).json({ error: `Novita API ${resp.status}`, details: txt.slice(0, 500) });
      }

      const jr = await resp.json();
      const taskId = jr?.task_id || jr?.id || jr?.job_id;
      if (!taskId) {
        return res.status(500).json({ error: "Novita API: не вернулся task_id" });
      }

      // Поллинг результата
      const started = Date.now();
      const deadline = started + 60_000; // 60 сек таймаут
      let done = false;
      while (!done && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 1200));
        const r2 = await fetch(NOVITA_TASK_URL(taskId), { headers: commonHeaders });
        if (!r2.ok) continue;
        const j2 = await r2.json();

        // Примеры статусов: "queued" | "processing" | "completed" | "failed"
        const st = (j2?.status || j2?.state || "").toLowerCase();
        if (st === "completed" || st === "succeeded" || st === "success") {
          imageB64 =
            j2?.images?.[0]?.b64_json ||
            j2?.images?.[0]?.base64 ||
            j2?.result?.[0]?.b64 ||
            j2?.result?.[0]?.base64 ||
            null;
          done = true;
          break;
        }
        if (st === "failed" || st === "error") {
          const msg = j2?.message || j2?.error || "Generation failed";
          return res.status(500).json({ error: `Novita task failed: ${msg}` });
        }
      }

      if (!imageB64) {
        return res.status(504).json({ error: "Novita API timeout: не дождались изображения" });
      }
    }

    // 4) Сохраняем картинку в кэш на сегодня. Если в промежутке параллельная ручка уже сохранила — не страшно.
    await sql`
      UPDATE user_calendar
      SET image_base64 = ${imageB64}, image_generated = TRUE
      WHERE vk_user_id = ${vkUserId} AND date = ${today}
    `;

    return res.status(200).json({ image_base64: imageB64 });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
}
