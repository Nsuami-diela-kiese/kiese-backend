const db = require('../db');

async function setBusyByPhone(phone, busy) {
  if (!phone) return;
  await db.query(
    `UPDATE drivers
        SET on_ride = $2,
            available = CASE WHEN $2 THEN false ELSE available END
      WHERE phone = $1`,
    [phone, !!busy]
  );
}

module.exports = { setBusyByPhone };
