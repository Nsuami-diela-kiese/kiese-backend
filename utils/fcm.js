// utils/fcm.js
const admin = require("firebase-admin");

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

async function sendFcm(token, { title, body }, data = {}) {
  if (!token) return;
  return admin.messaging().send({
    token,
    notification: { title, body }, // nécessaire pour affichage quand app est en arrière-plan/tuée
    data,
    android: { priority: "high" },
  });
}

module.exports = { sendFcm };
