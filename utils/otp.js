// utils/otp.js
const crypto = require('crypto');

// TTL en minutes (par défaut 5)
const OTP_TTL_MIN = parseInt(process.env.OTP_TTL_MIN || '5', 10);

// OTP figé (pour tests / politique d’accès)
const OTP_TEST_PHONE = (process.env.OTP_TEST_PHONE || '').trim(); // ex: "+243847371717"
const OTP_TEST_CODE  = (process.env.OTP_TEST_CODE  || '').trim(); // ex: "123456"

function isE164(p) {
  const s = String(p || '').trim();
  // + et 8 à 15 chiffres
  return /^\+\d{8,15}$/.test(s);
}

function randCode6() {
  // 6 chiffres (100000 - 999999)
  return String(Math.floor(Math.random() * 900000) + 100000);
}

function hashCode(code) {
  return crypto.createHash('sha256').update(String(code || '')).digest('hex');
}

function expiryDateFromNow() {
  const d = new Date();
  d.setMinutes(d.getMinutes() + OTP_TTL_MIN);
  return d;
}

// ——— OTP figé ———
function hasTestOverride(phone) {
  if (!OTP_TEST_PHONE || !OTP_TEST_CODE) return false;
  return String(phone || '').trim() === OTP_TEST_PHONE;
}
function isTestOtp(phone, code) {
  return hasTestOverride(phone) && String(code || '').trim() === OTP_TEST_CODE;
}

module.exports = {
  OTP_TTL_MIN,
  isE164,
  randCode6,
  hashCode,
  expiryDateFromNow,
  hasTestOverride,
  isTestOtp,
};
