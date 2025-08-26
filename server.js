
const express = require('express');
require('dotenv').config();
const app = express();
const { sendFcm } = require('./utils/fcm'); // ⬅️ helper que tu vas créer à l’étape 4 si pas déjà fait
const db = require('./db');                 // ⬅️ ton module DB existant


// ✅ Middleware JSON
app.use(express.json());

// ✅ Middleware de debug pour toutes les requêtes
app.use((req, res, next) => {
  console.log("🧪 METHOD:", req.method, "| PATH:", req.path, "| BODY:", req.body);
  next();
});

// 📦 Routes
const rideRoutes = require('./routes/rides');
app.use('/api/ride', rideRoutes);

const driverRoutes = require('./routes/drivers');
app.use('/api/driver', driverRoutes);

const agentsRoutes = require('./routes/agents');
app.use('/api/agent', agentsRoutes);

const appRoutes = require('./routes/app');     // ⬅️ importer
app.use('/api/app', appRoutes);  


// ✅ PORT
const PORT = process.env.PORT || 3000;
console.log("✅ TWILIO_SID:", process.env.TWILIO_SID);
console.log("✅ TWILIO_TOKEN:", process.env.TWILIO_TOKEN);
console.log("✅ TWILIO_PHONE:", process.env.TWILIO_PHONE);


// 🔔 Test d'envoi FCM à un chauffeur par son téléphone
app.get('/api/test/ping_fcm/:phone', async (req, res) => {
  try {
    const { phone } = req.params;

    // Récupérer le token FCM côté DB (table "drivers")
    const r = await db.query('SELECT fcm_token FROM drivers WHERE phone = $1', [phone]);
    const token = r.rows[0]?.fcm_token;

    if (!token) {
      return res.status(404).json({ error: 'Aucun token FCM trouvé pour ce téléphone' });
    }

    // Envoyer une notif de test
    await sendFcm(
      token,
      { title: 'Test Kiese', body: 'Hello depuis le backend' },
      { type: 'new_ride', ride_id: '123' } // data pour router côté app
    );

    return res.json({ ok: true });
  } catch (e) {
    console.error('ping_fcm error:', e);
    return res.status(500).json({ error: 'send error' });
  }
});



app.listen(PORT, () => {
  console.log(`✅ Serveur démarré sur le port ${PORT}`);
});




