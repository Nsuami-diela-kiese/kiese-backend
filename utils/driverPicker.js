// utils/driverPicker.js
const db = require('../db');

/**
 * Tente de réserver 1 chauffeur atomiquement dans un rayon donné (km).
 * Retourne {phone, lat, lng} ou null.
 */
async function _pickOnce({ originLat, originLng, excludePhones = [], radiusKm, minSolde = 3000 }) {
  const sql = `
    WITH ranked AS (
      SELECT
        d.phone, d.lat, d.lng,
        sqrt( ((d.lat - $1) * 111.2)^2 + ((d.lng - $2) * 111.2 * cos(radians($1)))^2 ) AS km
      FROM drivers d
      WHERE d.available = true
        AND d.on_ride  = false
        AND d.blocked  = false
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
       SET on_ride = true,
           available = false
      FROM candidate c
     WHERE d.phone = c.phone
     RETURNING d.phone, d.lat, d.lng;
  `;
  const params = [originLat, originLng, excludePhones, radiusKm, minSolde];
  const { rows } = await db.query(sql, params);
  return rows[0] || null;
}

/**
 * Essaie plusieurs rayons (ex: 3 → 6 → 10 → 15 km) jusqu'à trouver.
 */
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

module.exports = { pickNearestDriverAtomicFallback };
