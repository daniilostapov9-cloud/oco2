// /api/generate-outfit.js
const API_KEY = process.env.GEMINI_API_KEY;
// Можно сменить на актуальную модель у тебя в проекте
const API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent";

function parseCookies(req){
  const header = req.headers.cookie || '';
  return Object.fromEntries(header.split(';').map(v=>v.trim().split('=').map(decodeURIComponent)).filter(p=>p[0]));
}
function systemPrompt(){
  return `Ты — модный ИИ-стилист. На основе настроения и пола предложи цельный наряд на СЕГОДНЯ.
Формат отвечай кратко и практично:
— Верх:
— Низ:
— Обувь:
— Аксессуары:
— Палитра:
(1–2 предложения, почему это подойдёт сегодня.)`;
}
async function callGemini(text){
  const payload = {
    contents: [{ role:"user", parts:[{ text }] }],
    systemInstruction: { parts:[{ text: systemPrompt() }] }
  };
  const r = await fetch(`${API_URL}?key=${API_KEY}`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify(payload)
  });
  if(!r.ok){
    const b = await r.text();
    throw new Error(`Google API error ${r.status}: ${b}`);
  }
  const j = await r.json();
  const out = j?.candidates?.[0]?.content?.parts?.[0]?.text;
  if(!out) throw new Error('Пустой ответ от Google.');
  return out.trim();
}

export default async function handler(req, res){
  try{
    if(req.method!=='POST') return res.status(405).json({ error:'Method Not Allowed' });

    const cookies  = parseCookies(req);
    const vkToken  = cookies['vk_id_token'];
    const vkUserId = cookies['vk_user_id'];
    if(!vkToken || !vkUserId) return res.status(401).json({ error:'Требуется авторизация через приложение ОСО' });

    const { date, mood, gender } = req.body || {};
    if(!date || !mood || !gender) return res.status(400).json({ error:'Не хватает полей' });

    const prompt = `Сегодня. Пол: ${gender}. Настроение: ${mood}.
Собери удобный и стильный городской образ на текущий сезон (без упора на бренды).`;
    const outfit = await callGemini(prompt);
    return res.status(200).json({ outfit });
  }catch(e){
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
}
