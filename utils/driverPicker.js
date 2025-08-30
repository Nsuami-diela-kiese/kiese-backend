
const db = require('../db');

/**
 * Sélectionne et RÉSERVE (on_ride=true, available=false) un chauffeur atomiquement.
 * - excludePhones: array de phones déjà contactés
 * - radiusKm: rayon max (km)
 * Retourne { phone, lat, lng } ou null si aucun candidat.
 */
async function pickNearestDriverAtomic({ originLat, originLng, excludePhones = [], radiusKm = 15 }) {
  // ⚠️ Equirectangular (précis à l’échelle urbaine)
  // distance_km = sqrt( ((lat-lat0)*111.2)^2 + ((lng-lng0)*111.2*cos(lat0))^2 )

  const params = [
    originLat,                   // $1
    originLng,                   // $2
    excludePhones,               // $3
    radiusKm                     // $4
  ];

  const sql = `
    WITH ranked AS (
      SELECT
        d.phone,
        d.lat,
        d.lng,
        /* distance en km */
        sqrt( ((d.lat - $1) * 111.2)^2 + ((d.lng - $2) * 111.2 * cos(radians($1)))^2 ) AS km
      FROM drivers d
      WHERE d.available = true
        AND d.blocked   = false
        AND d.on_ride   = false
        AND (array_length($3::text[], 1) IS NULL OR d.phone <> ALL($3))
    ),
    candidate AS (
      SELECT phone
      FROM ranked
      WHERE km <= $4
      ORDER BY km ASC, random()   -- tie-breaker aléatoire
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

  const { rows } = await db.query(sql, params);
  return rows[0] || null;
}

module.exports = { pickNearestDriverAtomic };
