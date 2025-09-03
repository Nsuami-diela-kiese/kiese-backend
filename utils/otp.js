// utils/otp.js
const crypto = require('crypto');

const OTP_LENGTH  = parseInt(process.env.OTP_LENGTH  || '6', 10);
const OTP_TTL_MIN = parseInt(process.env.OTP_TTL_MIN || '5', 10);
const OTP_SECRET  = process.env.OTP_SECRET || 'change-me';

function generateNumericCode(len = OTP_LENGTH) {
  let out = '';
  for (let i = 0; i < len; i++) out += Math.floor(Math.random() * 10);
  return out;
}

function hashCode(code) {
  return crypto.createHash('sha256').update(`${code}:${OTP_SECRET}`).digest('hex');
}

function isE164(phone) { return /^\+\d{8,15}$/.test(phone); }

function expiryDateFromNow() {
  const d = new Date();
  d.setMinutes(d.getMinutes() + OTP_TTL_MIN);
  return d;
}

module.exports = {
  OTP_LENGTH,
  OTP_TTL_MIN,
  generateNumericCode,
  // ✅ alias pour compat avec l’ancien nom
  randCode6: generateNumericCode,
  hashCode,
  isE164,
  expiryDateFromNow,
};
