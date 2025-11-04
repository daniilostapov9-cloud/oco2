import { sql } from "@vercel/postgres";

function parseCookies(req){
  const h = req.headers.cookie || '';
  return Object.fromEntries(h.split(';').map(v=>v.trim().split('=').map(decodeURIComponent)).filter(p=>p[0]));
}

export default async function handler(req, res){
  try{
    const cookies = parseCookies(req);
    const vkUserId = cookies['vk_user_id'];
    if(!vkUserId) return res.status(401).json({ error: "Нет vk_user_id" });

    const month = Number(req.query.month);
    const year  = Number(req.query.year);
    if(!month || !year) return res.status(400).json({ error: "Нужны ?year=YYYY&month=MM" });

    const mm = String(month).padStart(2,'0');
    const start = `${year}-${mm}-01`;
    const endMonth = month === 12 ? 1 : month+1;
    const endYear  = month === 12 ? year+1 : year;
    const end = `${endYear}-${String(endMonth).padStart(2,'0')}-01`;

    const { rows } = await sql`
      SELECT date, mood, gender, outfit, confirmed
      FROM user_calendar
      WHERE vk_user_id = ${vkUserId}
        AND date >= ${start} AND date < ${end}
      ORDER BY date ASC
    `;
    res.status(200).json({ entries: rows });
  }catch(e){
    console.error(e);
    res.status(500).json({ error: e.message });
  }
}
