
// utils/reassign.js
const { pool } = require('../db');
const { selectNearestDriverHaversine } = require('./driverSelector.haversine');

/**
 * Réassigne un driver pour une course.
 * Retour: { ok:true, driver } ou { ok:false, reason }
 */
async function reassignDriverForRide(rideId) {
  // 1) Charger la course
  const { rows } = await pool.query(
    `SELECT id, origin_lat, origin_lng, contacted_driver_phones,
            reassign_attempts, max_reassign_attempts
       FROM rides
      WHERE id = $1`,
    [rideId]
  );
  const ride = rows[0];
  if (!ride) return { ok: false, reason: 'RIDE_NOT_FOUND' };

  if (ride.reassign_attempts >= ride.max_reassign_attempts) {
    return { ok: false, reason: 'MAX_ATTEMPTS_REACHED' };
  }

  const exclude = Array.isArray(ride.contacted_driver_phones)
    ? ride.contacted_driver_phones
    : [];

  // 2) Sélection du plus proche (Haversine)
  const driver = await selectNearestDriverHaversine({
    originLat: ride.origin_lat,
    originLng: ride.origin_lng,
    excludePhones: exclude,
  });

  if (!driver) {
    // Option: on compte quand même une tentative
    await pool.query(
      `UPDATE rides SET reassign_attempts = reassign_attempts + 1 WHERE id = $1`,
      [rideId]
    );
    return { ok: false, reason: 'NO_DRIVER_AVAILABLE' };
  }

  const updatedExclude = [...new Set([...exclude, driver.phone])];

  // 3) Mettre à jour la course
  await pool.query(
    `UPDATE rides
        SET driver_phone = $1,
            status = 'en_attente',
            reassign_attempts = reassign_attempts + 1,
            contacted_driver_phones = $2
      WHERE id = $3`,
    [driver.phone, updatedExclude, rideId]
  );

  return { ok: true, driver };
}

module.exports = { reassignDriverForRide };
