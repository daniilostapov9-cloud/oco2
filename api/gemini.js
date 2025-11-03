// /api/gemini.js
const API_KEY = process.env.GEMINI_API_KEY;
const API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent";
const USAGE_SECRET = process.env.USAGE_SECRET || 'dev-secret-change-me'; // секрет для подписи cookie

const SYSTEM_PROMPT = `Ты — модный ИИ-стилист... (как у тебя)`;

function sign(str, secret){
  const crypto = require('crypto');
  return crypto.createHmac('sha256', secret).update(str).digest('hex');
}
function parseCookies(req){
  const header = req.headers.cookie || '';
  return Object.fromEntries(header.split(';').map(v=>v.trim().split('=').map(decodeURIComponent)).filter(p=>p[0]));
}
function getToday(){ return new Date().toISOString().slice(0,10); }

// простая подписанная кука вида: base64(json).hexsig
function readSignedUsage(req){
  const cookies = parseCookies(req);
  const raw = cookies['oso_usage'];
  if(!raw) return null;
  const [b64, sig] = raw.split('.');
  if(!b64 || !sig) return null;
  const ok = sign(b64, USAGE_SECRET) === sig;
  if(!ok) return null;
  try{ return JSON.parse(Buffer.from(b64, 'base64url').toString('utf8')); }
  catch{ return null; }
}
function writeSignedUsage(res, data){
  const b64 = Buffer.from(JSON.stringify(data)).toString('base64url');
  const sig = sign(b64, USAGE_SECRET);
  const cookie = `oso_usage=${b64}.${sig}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60*60*24*7}`;
  res.setHeader('Set-Cookie', cookie);
}

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

export default async function handler(req, res){
  if(req.method !== 'POST') return res.status(405).json({error:'Method Not Allowed'});

  // 1) Авторизация: нужна кука vk_id_token (ставит Android-приложение)
  const cookies = parseCookies(req);
  const vkToken = cookies['vk_id_token'];
  if(!vkToken){
    return res.status(401).json({ error: 'Требуется авторизация через приложение ОСО' });
  }

  // 2) Лимит 5/день — серверная проверка/обновление
  const usage = readSignedUsage(req) || { date: getToday(), count: 0 };
  if(usage.date !== getToday()){ usage.date = getToday(); usage.count = 0; }
  if(usage.count >= 5){
    writeSignedUsage(res, usage);
    return res.status(429).json({ error: 'Лимит 5 анализов в день исчерпан. Попробуй завтра.' });
  }

  try{
    const { imageData } = req.body || {};
    if(!imageData) return res.status(400).json({ error:'Картинка не получена (imageData missing)' });

    const payload = {
      contents: [{
        role: "user",
        parts: [
          { text: "Проанализируй одежду на этом фото." },
          { inlineData: { mimeType: "image/jpeg", data: imageData } }
        ]
      }],
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] }
    };

    const analysisText = await callGeminiWithRetry(API_URL, payload);

    // Успешно — увеличиваем счётчик и возвращаем ответ
    usage.count += 1;
    writeSignedUsage(res, usage);
    return res.status(200).json({ text: analysisText });

  }catch(err){
    console.error('Ошибка /api/gemini:', err);
    return res.status(500).json({ error: `Ошибка сервера: ${err.message}` });
  }
}
