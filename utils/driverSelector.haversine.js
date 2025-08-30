// utils/driverSelector.haversine.js
const db = require('../db');

/**
 * Retourne { phone, km } du chauffeur disponible le plus proche,
 * en excluant ceux déjà contactés (excludePhones).
 */
async function selectNearestDriverHaversine({ originLat, originLng, excludePhones = [] }) {
  if (originLat == null || originLng == null) {
    return null; // garde-fou si la course n'a pas d'origine
  }

  const sql = `
    WITH params AS (
      SELECT $1::float AS lat1, $2::float AS lon1
    )
    SELECT d.phone,
           (6371 * acos(
             cos(radians(p.lat1)) * cos(radians(d.lat)) * cos(radians(d.lng) - radians(p.lon1)) +
             sin(radians(p.lat1)) * sin(radians(d.lat))
           )) AS km
    FROM drivers d, params p
    WHERE d.available = TRUE
      AND d.lat IS NOT NULL AND d.lng IS NOT NULL
      AND NOT (d.phone = ANY($3::text[]))
    ORDER BY km ASC
    LIMIT 1;
  `;

  const exclude = Array.isArray(excludePhones) ? excludePhones : [];
  const { rows } = await db.query(sql, [originLat, originLng, exclude]);
  return rows[0] || null; // { phone, km }
}

module.exports = { selectNearestDriverHaversine };
