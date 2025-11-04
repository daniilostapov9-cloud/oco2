// /api/calendar-set.js
export const config = { runtime: 'nodejs' }; // без версии!
import { sql } from "@vercel/postgres";

function parseCookies(req){
  const header = req.headers.cookie || '';
  return Object.fromEntries(header.split(';').map(v=>v.trim().split('=').map(decodeURIComponent)).filter(p=>p[0]));
}
function ymdZurich(date){
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich', year:'numeric', month:'2-digit', day:'2-digit' })
    .formatToParts(date).reduce((a,p)=> (a[p.type]=p.value, a), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export default async function handler(req, res){
  try{
    if(req.method!=='POST') return res.status(405).json({ error:'Method Not Allowed' });

    const cookies  = parseCookies(req);
    const vkUserId = cookies['vk_user_id'];
    if(!vkUserId) return res.status(401).json({ error: "Нет vk_user_id" });

    const { date, mood, gender, outfit } = req.body || {};
    if(!date || !mood || !gender || !outfit) return res.status(400).json({ error:'Не хватает полей' });

    // Разрешаем только СЕГОДНЯ (Europe/Zurich)
    const now = new Date();
    const mustBe = ymdZurich(now);
    if (date !== mustBe) {
      return res.status(400).json({ error:`Выбрать можно только СЕГОДНЯ: ${mustBe}` });
    }

    // Вставка; ключ (vk_user_id, date) не даст продублировать
    await sql`
      INSERT INTO user_calendar (vk_user_id, date, mood, gender, outfit)
      VALUES (${vkUserId}, ${date}, ${mood}, ${gender}, ${outfit})
    `;
    return res.status(200).json({ ok:true });
  }catch(e){
    if (String(e.message).includes('duplicate key')) {
      return res.status(409).json({ error:'На сегодня уже сохранено' });
    }
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
}
