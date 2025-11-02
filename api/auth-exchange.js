// /api/auth-exchange.js — Vercel Serverless (Node.js)

// 1) Firebase Admin (только на бэкенде):
// Помести JSON сервис-аккаунта в переменную окружения FIREBASE_SERVICE_ACCOUNT
import admin from "firebase-admin";

if (!admin.apps.length) {
  const svc = process.env.FIREBASE_SERVICE_ACCOUNT; // строка JSON
  if (!svc) throw new Error("FIREBASE_SERVICE_ACCOUNT env var is missing");
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(svc))
  });
}

// 2) Вспомогательные запросы к провайдерам
async function getYandexProfile(oauthToken) {
  const r = await fetch("https://login.yandex.ru/info?format=json", {
    headers: { Authorization: `OAuth ${oauthToken}` }
  });
  if (!r.ok) throw new Error("yandex_token_invalid");
  return await r.json();
}

async function getVkProfile(accessToken) {
  const r = await fetch(`https://api.vk.com/method/users.get?access_token=${accessToken}&v=5.199&fields=photo_200`);
  const json = await r.json();
  if (!json.response || !json.response[0]) throw new Error("vk_token_invalid");
  return json.response[0];
}

// 3) Обработчик
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  try {
    const { provider, token } = req.body || {};
    if (!provider || !token) return res.status(400).json({ error: "bad_request" });

    let uid, displayName, photoURL;

    if (provider === "yandex") {
      const info = await getYandexProfile(token);
      uid = `yandex:${info.id}`;
      displayName = info.display_name || info.real_name || "";
      photoURL = info.default_avatar_id
        ? `https://avatars.yandex.net/get-yapic/${info.default_avatar_id}/islands-200`
        : undefined;

    } else if (provider === "vk") {
      const u = await getVkProfile(token);
      uid = `vk:${u.id}`;
      displayName = `${u.first_name || ""} ${u.last_name || ""}`.trim();
      photoURL = u.photo_200;

    } else {
      return res.status(400).json({ error: "unknown_provider" });
    }

    const customToken = await admin.auth().createCustomToken(uid, { provider, displayName, photoURL });
    return res.status(200).json({ firebase_custom_token: customToken });

  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "exchange_failed" });
  }
}
