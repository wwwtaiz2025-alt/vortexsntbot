const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname)));

// استيراد المسارات
const authRoutes = require('./routes/auth');
const miningRoutes = require('./routes/mining');
const walletRoutes = require('./routes/wallet');
const marketRoutes = require('./routes/market');
const gamesRoutes = require('./routes/games');

app.use('/api', authRoutes);
app.use('/api', miningRoutes);
app.use('/api', walletRoutes);
app.use('/api', marketRoutes);
app.use('/api/games', gamesRoutes);

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`🚀 Vortex server running on port ${PORT}`);
});
