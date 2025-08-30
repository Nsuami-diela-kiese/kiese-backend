
// utils/driverFlags.js
const db = require('../db');

async function setBusyByPhone(phone, busy = true) {
  if (!phone) return;
  await db.query(`
    UPDATE drivers SET on_ride = $1
    WHERE TRIM(phone) = TRIM($2)
  `, [busy, phone]);
}

async function setAvailableByPhone(phone, available = true) {
  if (!phone) return;
  await db.query(`
    UPDATE drivers SET available = $1
    WHERE TRIM(phone) = TRIM($2)
  `, [available, phone]);
}

module.exports = { setBusyByPhone, setAvailableByPhone };
