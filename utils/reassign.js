// utils/reassign.js
const db = require('../db');
const { selectNearestDriverHaversine } = require('./driverSelector.haversine');
const { setBusyByPhone } = require('./driverFlags');

async function reassignDriverForRide(rideId) {
  const { rows } = await db.query(
    `SELECT id, origin_lat, origin_lng, driver_phone, contacted_driver_phones,
            reassign_attempts, max_reassign_attempts
       FROM rides
      WHERE id = $1`,
    [rideId]
  );
  const ride = rows[0];
  if (!ride) return { ok: false, reason: 'RIDE_NOT_FOUND' };
  if (ride.origin_lat == null || ride.origin_lng == null) {
    return { ok: false, reason: 'ORIGIN_MISSING' };
  }

  const max = ride.max_reassign_attempts ?? 5;
  if ((ride.reassign_attempts ?? 0) >= max) {
    return { ok: false, reason: 'MAX_ATTEMPTS_REACHED' };
  }

  const exclude = Array.isArray(ride.contacted_driver_phones) ? ride.contacted_driver_phones : [];
  if (ride.driver_phone) exclude.push(ride.driver_phone); // évite de retomber sur le même

  const driver = await selectNearestDriverHaversine({
    originLat: ride.origin_lat,
    originLng: ride.origin_lng,
    excludePhones: exclude,
    radiusMetersList: [1500, 3000, 6000, 10000, 15000],
    useFlags: true,
  });

  if (!driver) {
    await db.query(
      `UPDATE rides SET reassign_attempts = COALESCE(reassign_attempts,0) + 1 WHERE id = $1`,
      [rideId]
    );
    return { ok: false, reason: 'NO_DRIVER_AVAILABLE' };
  }

  const updatedExclude = [...new Set([...exclude, driver.phone])];

  // 🔒 Réserver / libérer les chauffeurs
  await setBusyByPhone(ride.driver_phone, false);   // libère l'ancien (si existant)
  await setBusyByPhone(driver.phone, true);         // réserve le nouveau

  await db.query(
    `UPDATE rides
        SET driver_phone = $1,
            status = 'en_attente',
            reassign_attempts = COALESCE(reassign_attempts,0) + 1,
            contacted_driver_phones = $2
      WHERE id = $3`,
    [driver.phone, updatedExclude, rideId]
  );

  return { ok: true, driver };
}

module.exports = { reassignDriverForRide };
