// utils/sms.js
const twilio = require('twilio');

const SID   = process.env.TWILIO_SID;
const TOKEN = process.env.TWILIO_TOKEN;
const FROM  = process.env.TWILIO_PHONE; // e.g. +15005550006 (numéro Twilio E.164)

let client = null;
function tw() {
  if (!client) client = twilio(SID, TOKEN);
  return client;
}

/**
 * Envoie un SMS via Twilio
 * @param {string} to   - numéro E.164 (+243…)
 * @param {string} body - message
 */
async function sendSms(to, body) {
  if (!SID || !TOKEN || !FROM) throw new Error('TWILIO_ENV_MISSING');
  return tw().messages.create({ from: FROM, to, body });
}

module.exports = { sendSms };
