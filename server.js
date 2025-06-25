const express = require('express');
require('dotenv').config();
const app = express();

app.use(express.json()); // ✅ Pour pouvoir lire req.body

const rideRoutes = require('./routes/rides');
app.use('/api/ride', rideRoutes);

const driverRoutes = require('./routes/drivers');
app.use('/api/driver', driverRoutes);

// 🔧 Utiliser le port fourni par Cloud Run
const PORT = process.env.PORT || 3000;
console.log("✅ TWILIO_SID:", process.env.TWILIO_SID);
console.log("✅ TWILIO_TOKEN:", process.env.TWILIO_TOKEN);
console.log("✅ TWILIO_PHONE:", process.env.TWILIO_PHONE);

app.listen(PORT, () => {
  console.log(`✅ Serveur démarré sur le port ${PORT}`);
});
