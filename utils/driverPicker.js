// utils/driverPicker.js
const db = require('../db');

async function _pickOnce({ originLat, originLng, excludePhones = [], radiusKm, minSolde = 3000 }) {
  const params = [originLat, originLng, excludePhones, radiusKm, minSolde];
  const sql = `
    WITH ranked AS (
      SELECT
        d.phone, d.lat, d.lng,
        6371 * acos(
          cos(radians($1)) * cos(radians(d.lat)) * cos(radians(d.lng) - radians($2))
          + sin(radians($1)) * sin(radians(d.lat))
        ) AS km
      FROM drivers d
      WHERE d.available = TRUE
        AND d.on_ride  = FALSE
        AND d.blocked  = FALSE
        AND d.solde   >= $5
        AND (array_length($3::text[], 1) IS NULL OR d.phone <> ALL($3))
    ),
    candidate AS (
      SELECT phone
      FROM ranked
      WHERE km <= $4
      ORDER BY km ASC, random()
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE drivers d
       SET on_ride = TRUE
      FROM candidate c
     WHERE d.phone = c.phone
     RETURNING d.phone, d.lat, d.lng;
  `;
  const { rows } = await db.query(sql, params);
  return rows[0] || null;
}

async function pickNearestDriverAtomicFallback({
  originLat,
  originLng,
  excludePhones = [],
  radii = [3, 6, 10, 15],
  minSolde = 3000,
}) {
  for (const r of radii) {
    const found = await _pickOnce({ originLat, originLng, excludePhones, radiusKm: r, minSolde });
    if (found) return found;
  }
  return null;
}

module.exports = { _pickOnce, pickNearestDriverAtomicFallback };
