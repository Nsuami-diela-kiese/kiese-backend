// utils/reassign.js
const db = require('../db');
const { selectNearestDriverHaversine } = require('./driverSelector.haversine');

/**
 * Réassigne un driver pour une course.
 * Retour: { ok:true, driver } ou { ok:false, reason }
 */
async function reassignDriverForRide(rideId) {
  // 1) Charger la course
  const { rows } = await db.query(
    `SELECT id, origin_lat, origin_lng, contacted_driver_phones,
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

  const exclude = Array.isArray(ride.contacted_driver_phones)
    ? ride.contacted_driver_phones
    : [];

  // 2) Sélection Haversine
  const driver = await selectNearestDriverHaversine({
    originLat: ride.origin_lat,
    originLng: ride.origin_lng,
    excludePhones: exclude,
  });

  if (!driver) {
    await db.query(
      `UPDATE rides SET reassign_attempts = COALESCE(reassign_attempts,0) + 1 WHERE id = $1`,
      [rideId]
    );
    return { ok: false, reason: 'NO_DRIVER_AVAILABLE' };
  }

  const updatedExclude = [...new Set([...exclude, driver.phone])];

  // 3) Mettre à jour la course
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
