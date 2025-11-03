// /api/gemini.js

// 1. Импорт для работы с БД
export const config = { runtime: 'nodejs' }; // без версии!
import { sql } from "@vercel/postgres";

// 2. Константы (Gemini и наш лимит)
const API_KEY = process.env.GEMINI_API_KEY;
const API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent";
const DAILY_LIMIT = 5; // Наш лимит

// 3. Системный промпт (ОБНОВЛЕН)
const SYSTEM_PROMPT = `Ты — модный ИИ-стилист. Твоя задача — проанализировать фотографию человека и дать оценку его образу. Отвечай на русском языке. Твой ответ должен быть четко структурирован по четырем пунктам, которые запросил пользователь, и никак иначе:

Вы одеты в: [краткий список одежды на фото]
Ваш стиль: [название стиля, например: 'Кэжуал', 'Спортивный', 'Деловой', 'Классический', 'Минимализм', 'Бохо', 'Гранж', 'Преппи', 'Романтический', 'Вечерний', 'Деловой', 'Стритвир', 'Панк', 'Cпорт+Кэжуал', 'Тихая Роскошь', 'Футбольный Фанат', 'Деревенский' , 'Стиль 90-х' , 'Стиль 60-х' , 'Стиль 2000-х'.Не ограничивайся никакими примерами, выбери то, что лучше всего описывает образ]
Оценка образа: [одно-два прилагательных, описывающих образ, например: "Игривый", "Серьезный", "Обворожительный", "Раскрепощенный", "Элегантный".Не ограничивайся никакими примерами, выбери то, что лучше всего описывает образ]
Что можно добавить: [1-3 конкретных совета, что добавить или изменить]`;

// 4. Вспомогательные функции (без изменений)
function parseCookies(req){
  const header = req.headers.cookie || '';
  return Object.fromEntries(header.split(';').map(v=>v.trim().split('=').map(decodeURIComponent)).filter(p=>p[0]));
}
function getToday(){ return new Date().toISOString().slice(0,10); }
async function callGeminiWithRetry(url, payload, retries=3, delay=1000){
  for(let i=0;i<retries;i++){
    try{
      const response = await fetch(`${url}?key=${API_KEY}`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify(payload)
      });
      if(!response.ok){
        const body = await response.text();
        throw new Error(`Google API error ${response.status}: ${body}`);
      }
      const result = await response.json();
      const text = result?.candidates?.[0]?.content?.parts?.[0]?.text;
      if(!text) throw new Error('Пустой ответ от Google.');
      return text;
    }catch(err){
      if(i===retries-1) throw err;
      await new Promise(r=>setTimeout(r, delay*Math.pow(2,i)));
    }
  }
}

// 5. Главный обработчик (без изменений)
export default async function handler(req, res){
  if(req.method !== 'POST') return res.status(405).json({error:'Method Not Allowed'});
  const cookies = parseCookies(req);
  const vkToken = cookies['vk_id_token'];
  const vkUserId = cookies['vk_user_id']; 
  if(!vkToken || !vkUserId){
    return res.status(401).json({ error: 'Требуется авторизация через приложение ОСО' });
  }
  const today = getToday();
  let currentCount = 0;
  try {
    const { rows } = await sql`
      SELECT daily_count, last_used_date FROM user_limits 
      WHERE vk_user_id = ${vkUserId}
    `;
    const userLimit = rows[0];
    if (!userLimit) {
      currentCount = 0;
    } else if (userLimit.last_used_date !== today) {
      currentCount = 0;
    } else {
      currentCount = userLimit.daily_count;
    }
    if (currentCount >= DAILY_LIMIT) {
      return res.status(429).json({ 
        error: `Лимит ${DAILY_LIMIT} анализов в день исчерпан. Попробуй завтра.`,
        remaining: 0 
      });
    }
  } catch (dbError) {
    console.error('Ошибка проверки лимита в БД:', dbError);
    return res.status(500).json({ error: `Ошибка сервера (БД): ${dbError.message}` });
  }
  try{
    const { imageData, image } = req.body || {};
    const b64Data = imageData || image;
    if(!b64Data) return res.status(400).json({ error:'Картинка не получена (imageData missing)' });
    const payload = {
      contents: [{
        role: "user",
        parts: [
          { text: "Проанализируй одежду на этом фото." },
          { inlineData: { mimeType: "image/jpeg", data: b64Data } }
        ]
      }],
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] }
    };
    const analysisText = await callGeminiWithRetry(API_URL, payload);
    const newCount = currentCount + 1;
    await sql`
      INSERT INTO user_limits (vk_user_id, daily_count, last_used_date)
      VALUES (${vkUserId}, ${newCount}, ${today})
      ON CONFLICT (vk_user_id) 
      DO UPDATE SET
        daily_count = ${newCount},
        last_used_date = ${today};
    `;
    return res.status(200).json({ 
      text: analysisText,
      remaining: DAILY_LIMIT - newCount 
    });
  }catch(err){
    console.error('Ошибка /api/gemini (Gemini или DB Update):', err);
    return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
  }
}
