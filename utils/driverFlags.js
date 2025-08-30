// utils/driverFlags.js
const db = require('../db');

/**
 * Réserve / libère le chauffeur pour une course
 * - NE CHANGE PAS 'available' (c'est le toggle "en ligne" coté app chauffeurs)
 */
async function setOnRideByPhone(phone, onRide) {
  await db.query(
    `UPDATE drivers SET on_ride = $2 WHERE phone = $1`,
    [phone, onRide]
  );
}

/**
 * Change le statut "en ligne" affiché dans l'app chauffeur
 */
async function setAvailableByPhone(phone, available) {
  await db.query(
    `UPDATE drivers SET available = $2 WHERE phone = $1`,
    [phone, available]
  );
}

/**
 * Alias pratique si tu utilises "busy" dans ton code
 * busy = on_ride
 */
async function setBusyByPhone(phone, busy) {
  return setOnRideByPhone(phone, busy);
}

module.exports = { setOnRideByPhone, setAvailableByPhone, setBusyByPhone };
