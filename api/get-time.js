// /api/get-time.js
export const config = { runtime: 'nodejs' }; 

const tz = 'Europe/Zurich';
const fmtMonth = (d) => new Intl.DateTimeFormat('ru-RU',{ timeZone:tz, month:'long'}).format(d).toUpperCase();
const fmtYear = (d) => new Intl.DateTimeFormat('ru-RU',{ timeZone:tz, year:'numeric'}).format(d);
const fmtTodayLabel = (d) => new Intl.DateTimeFormat('ru-RU',{ timeZone:tz, year:'numeric', month:'2-digit', day:'2-digit'}).format(d);
const ymd = (d) => new Intl.DateTimeFormat('en-CA',{ timeZone:tz, year:'numeric', month:'2-digit', day:'2-digit'}).format(d);

export default async function handler(req, res) {
  try {
    const now = new Date(); 
    
    const todayYMD = ymd(now);
    
    const local = new Date(new Intl.DateTimeFormat('en-CA',{timeZone:tz}).format(now)+'T00:00:00Z');
    const year = local.getUTCFullYear();
    const month = local.getUTCMonth(); // 0..11

    res.status(200).json({
      todayYMD: todayYMD,
      year: year,
      month: month, // 0-11 (JS-месяц)
      monthLabel: fmtMonth(now),
      yearLabel: fmtYear(now),
      todayLabel: 'Сегодня: ' + fmtTodayLabel(now)
    });
    
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to get server time' });
  }
}
