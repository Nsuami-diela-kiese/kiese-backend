
const express = require('express');
require('dotenv').config();
const app = express();

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


// ✅ PORT
const PORT = process.env.PORT || 3000;
console.log("✅ TWILIO_SID:", process.env.TWILIO_SID);
console.log("✅ TWILIO_TOKEN:", process.env.TWILIO_TOKEN);
console.log("✅ TWILIO_PHONE:", process.env.TWILIO_PHONE);

app.listen(PORT, () => {
  console.log(`✅ Serveur démarré sur le port ${PORT}`);
});



