// /api/get-limit.js
import { sql } from "@vercel/postgres";

function parseCookies(req){
  const header = req.headers.cookie || '';
  return Object.fromEntries(header.split(';').map(v=>v.trim().split('=').map(decodeURIComponent)).filter(p=>p[0]));
}
function getToday(){ return new Date().toISOString().slice(0,10); }

export default async function handler(req, res) {
  const cookies = parseCookies(req);
  const vkUserId = cookies['vk_user_id'];
  const DAILY_LIMIT = 5;

  if (!vkUserId) {
    return res.status(401).json({ error: "Нет vk_user_id" });
  }

  const today = getToday();

  try {
    const { rows } = await sql`
      SELECT daily_count, last_used_date FROM user_limits 
      WHERE vk_user_id = ${vkUserId}
    `;
    
    const userLimit = rows[0];
    let remaining = DAILY_LIMIT;

    if (userLimit && userLimit.last_used_date === today) {
      remaining = Math.max(0, DAILY_LIMIT - userLimit.daily_count);
    }
    
    return res.status(200).json({ remaining: remaining });

  } catch (dbError) {
    console.error('Ошибка /api/get-limit:', dbError);
    return res.status(500).json({ error: dbError.message });
  }
}
