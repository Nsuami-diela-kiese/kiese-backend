const express = require('express');
const app = express();

app.use(express.json()); // ✅ Pour pouvoir lire req.body

const rideRoutes = require('./routes/rides');
app.use('/api/ride', rideRoutes);

const driverRoutes = require('./routes/drivers');
app.use('/api/driver', driverRoutes);

// 🔧 Utiliser le port fourni par Cloud Run
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Serveur démarré sur le port ${PORT}`);
});
