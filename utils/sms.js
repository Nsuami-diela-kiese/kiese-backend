// utils/sms.js
const twilio = require('twilio');

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_FROM,
} = process.env;

let client = null;
if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
  client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
}

async function sendSMS(toE164, message) {
  if (!client) {
    console.warn('Twilio non configuré — SMS simulé:', toE164, message);
    return { sid: 'SIMULATED' };
  }
  return client.messages.create({
    from: TWILIO_FROM,
    to: toE164,
    body: message,
  });
}

module.exports = { sendSMS };
