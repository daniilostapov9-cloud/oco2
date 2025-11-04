// /api/calendar-set.js
export const config = { runtime: 'nodejs' }; // без версии!
// /api/calendar-set.js
import { sql } from "@vercel/postgres";

function parseCookies(req){
  const h = req.headers.cookie || '';
  return Object.fromEntries(h.split(';').map(v=>v.trim().split('=').map(decodeURIComponent)).filter(p=>p[0]));
}
function ymdZurich(d=new Date()){
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich', year:'numeric', month:'2-digit', day:'2-digit' })
    .formatToParts(d).reduce((a,p)=> (a[p.type]=p.value, a), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export default async function handler(req,res){
  try{
    if(req.method!=='POST') return res.status(405).json({ error:'Method Not Allowed' });
    const cookies = parseCookies(req);
    const vkUserId = cookies['vk_user_id'];
    if(!vkUserId) return res.status(401).json({ error: "Нет vk_user_id" });

    const { date, mood, gender, outfit } = req.body || {};
    if(!date || !mood || !gender || !outfit) return res.status(400).json({ error:'Не хватает полей' });

    const today = ymdZurich();
    if (date !== today) return res.status(400).json({ error:`Можно подтвердить только СЕГОДНЯ: ${today}` });

    await sql`
      INSERT INTO user_calendar (vk_user_id,date,mood,gender,outfit,confirmed,locked_until)
      VALUES (${vkUserId}, ${today}, ${mood}, ${gender}, ${outfit}, TRUE, NULL)
      ON CONFLICT (vk_user_id, date) DO UPDATE
      SET mood=EXCLUDED.mood, gender=EXCLUDED.gender, outfit=EXCLUDED.outfit,
          confirmed=TRUE, locked_until=NULL
    `;
    res.status(200).json({ ok:true });
  }catch(e){
    if (String(e.message).includes('duplicate key')) {
      return res.status(409).json({ error:'На сегодня уже сохранено' });
    }
    console.error(e);
    res.status(500).json({ error: e.message });
  }
}
