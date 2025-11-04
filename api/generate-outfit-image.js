// ---- перед запросом
const IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || "gpt-image-1";
const IMAGE_SIZE  = (process.env.OPENAI_IMAGE_SIZE || "512x512")
  .toLowerCase()
  .replace(/\s+/g, "");

// валидируем size
const ALLOWED_SIZES = new Set(["256x256","512x512","1024x1024"]);
const safeSize = ALLOWED_SIZES.has(IMAGE_SIZE) ? IMAGE_SIZE : "512x512";

const prompt = buildPrompt({ outfit, gender });

// ВАЖНО: без поля "quality"
const payload = {
  model: IMAGE_MODEL,
  prompt,
  size: safeSize,
  response_format: "b64_json"
};

const resp = await fetch("https://api.openai.com/v1/images/generations", {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
    "Content-Type": "application/json"
  },
  body: JSON.stringify(payload)
});

const bodyText = await resp.text();
if (!resp.ok) {
  // Сохраняем причину в БД и возвращаем её в ответ, чтобы сразу видеть реальную ошибку
  await sql`
    UPDATE user_calendar
    SET image_error=${bodyText.slice(0, 1000)}, image_attempted_today=TRUE
    WHERE vk_user_id=${vkUserId} AND date=${today}
  `;
  return res.status(resp.status).json({
    error: `OpenAI Images ${resp.status}`,
    details: bodyText.slice(0, 800)
  });
}

let data;
try { data = JSON.parse(bodyText); }
catch {
  return res.status(500).json({ error: "OpenAI: не-JSON", details: bodyText.slice(0, 400) });
}

const b64 = data?.data?.[0]?.b64_json || data?.data?.[0]?.base64;
if (!b64) {
  return res.status(500).json({ error: "OpenAI: нет b64 в ответе", details: JSON.stringify(data).slice(0, 500) });
}
