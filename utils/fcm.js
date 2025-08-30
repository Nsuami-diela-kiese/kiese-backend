// utils/fcm.js
const admin = require("firebase-admin");
const db = require('../db'); // 👈 pour lire le token

function getSvc() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT not set");
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

if (!admin.apps.length) {
  const svc = getSvc();
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: svc.project_id,
      clientEmail: svc.client_email,
      privateKey: svc.private_key.replace(/\\n/g, "\n"),
    }),
  });
}

async function getDriverFcmTokenByPhone(phone) {
  if (!phone) return null;
  const r = await db.query('SELECT fcm_token FROM drivers WHERE phone = $1', [phone]);
  return r.rows[0]?.fcm_token || null;
}

async function sendFcm(token, { title, body }, data = {}) {
  if (!token) return;
  // FCM data doit être stringifié
  const dataStr = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)]));
  return admin.messaging().send({
    token,
    notification: { title, body },
    data: dataStr,
    android: { priority: "high" },
  });
}

module.exports = { sendFcm, getDriverFcmTokenByPhone };
