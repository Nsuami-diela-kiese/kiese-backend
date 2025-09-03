// utils/testOtp.js
function loadTestOtpMap() {
  const raw = process.env.TEST_OTP_OVERRIDES || "";
  const map = new Map();
  raw.split(",")
    .map(s => s.trim())
    .filter(Boolean)
    .forEach(item => {
      const [phone, code] = item.split(":").map(x => x.trim());
      if (phone && code && /^\+\d{6,}$/.test(phone) && /^\d{4,8}$/.test(code)) {
        map.set(phone, code);
      }
    });
  return map;
}

const TEST_OTP_MAP = loadTestOtpMap();

function hasTestOverride(phone) {
  return TEST_OTP_MAP.has(phone);
}
function isTestOtp(phone, code) {
  return TEST_OTP_MAP.get(phone) === code;
}

module.exports = { hasTestOverride, isTestOtp };
