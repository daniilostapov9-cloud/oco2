// /api/gemini.js

// 1. Импорт для работы с БД
import { sql } from "@vercel/postgres";

// 2. Константы (Gemini и наш лимит)
const API_KEY = process.env.GEMINI_API_KEY;
const API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent";
const DAILY_LIMIT = 5; // Наш лимит

// 3. Системный промпт (твой)
const SYSTEM_PROMPT = `Ты — модный ИИ-стилист. Твоя задача — проанализировать фотографию человека и дать оценку его образу. Отвечай на русском языке. Твой ответ должен быть четко структурирован по четырем пунктам, которые запросил пользователь, и никак иначе:

Вы одеты в: [краткий список одежды на фото]
Ваш стиль: [название стиля, например: [название стиля, например: 'Кэжуал', 'Спортивный', 'Деловой', 'Классический', 'Минимализм', 'Бохо', 'Гранж', 'Преппи', 'Романтический', 'Вечерний', 'Деловой', 'Стритвир', 'Панк', 'Cпорт+Кэжуал', 'Тихая Роскошь', 'Футбольный Фанат', 'Деревенский' , 'Стиль 90-х' , 'Стиль 60-х' , 'Стиль 2000-х'.Не ограничивайся никакими примерами, выбери то, что лучше всего описывает образ]
Сочетание одежды: [оценка от 7 до 10, никогда не ниже 7]
Что можно добавить: [1-3 конкретных совета, что добавить или изменить]`;


// 4. Вспомогательные функции (старые)
//    УДАЛЕНЫ: sign, readSignedUsage, writeSignedUsage
//    ОСТАВЛЕНЫ: parseCookies, getToday, callGeminiWithRetry

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

// 5. Главный обработчик (полностью обновлен)
export default async function handler(req, res){
  if(req.method !== 'POST') return res.status(405).json({error:'Method Not Allowed'});

  // --- ШАГ 1: АВТОРИЗАЦИЯ ---
  // Получаем ДВЕ куки, которые ставит MainActivity.kt
  const cookies = parseCookies(req);
  const vkToken = cookies['vk_id_token']; // Проверка, что юзер вошел
  const vkUserId = cookies['vk_user_id']; // ID юзера для БД

  if(!vkToken || !vkUserId){
    return res.status(401).json({ error: 'Требуется авторизация через приложение ОСО' });
  }

  // --- ШАГ 2: ПРОВЕРКА ЛИМИТА В БАЗЕ ДАННЫХ ---
  const today = getToday();
  let currentCount = 0;

  try {
    const { rows } = await sql`
      SELECT daily_count, last_used_date FROM user_limits 
      WHERE vk_user_id = ${vkUserId}
    `;
    
    const userLimit = rows[0];

    if (!userLimit) {
      // Юзера нет в БД, это его первый запрос
      currentCount = 0;
    } else if (userLimit.last_used_date !== today) {
      // Юзер есть, но дата старая = новый день, сбрасываем
      currentCount = 0;
    } else {
      // Юзер есть, дата = сегодня, берем его счетчик
      currentCount = userLimit.daily_count;
    }
    
    // Проверяем лимит
    if (currentCount >= DAILY_LIMIT) {
      return res.status(429).json({ 
        error: `Лимит ${DAILY_LIMIT} анализов в день исчерпан. Попробуй завтра.`,
        remaining: 0 // Доп. инфо для UI
      });
    }

  } catch (dbError) {
    console.error('Ошибка проверки лимита в БД:', dbError);
    return res.status(500).json({ error: `Ошибка сервера (БД): ${dbError.message}` });
  }
  
  // --- ШАГ 3: ВСЕ ОК, ЗАПУСКАЕМ GEMINI ---
  try{
    // (Этот код берет картинку из req.body, как и раньше)
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

    // --- ШАГ 4: УСПЕХ. УВЕЛИЧИВАЕМ СЧЕТЧИК В БД ---
    const newCount = currentCount + 1;
    
    await sql`
      INSERT INTO user_limits (vk_user_id, daily_count, last_used_date)
      VALUES (${vkUserId}, ${newCount}, ${today})
      ON CONFLICT (vk_user_id) 
      DO UPDATE SET
        daily_count = ${newCount},
        last_used_date = ${today};
    `;

    // --- ШАГ 5: ОТДАЕМ РЕЗУЛЬТАТ ---
    return res.status(200).json({ 
      text: analysisText,
      remaining: DAILY_LIMIT - newCount // Отправляем остаток для UI
    });

  }catch(err){
    // Это `catch` для ошибок Gemini или Шага 4 (обновление БД)
    console.error('Ошибка /api/gemini (Gemini или DB Update):', err);
    return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
  }
}
