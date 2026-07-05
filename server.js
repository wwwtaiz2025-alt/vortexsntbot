const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// استيراد المسارات
const miningRoutes = require('./api/mining');
const transactionRoutes = require('./api/transactions');

app.use('/api', miningRoutes);
app.use('/api', transactionRoutes);

app.get('/', (req, res) => {
  res.send('Nexora Backend is running...');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
