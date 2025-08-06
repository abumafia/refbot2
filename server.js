const express = require('express');
const app = express();
const PORT = process.env.PORT || 10000;

// Asosiy route
app.get('/', (req, res) => {
  res.send('Telegram bot ishlayapti!');
});

// Sog'liqni tekshirish uchun endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Serverni ishga tushirish
const server = app.listen(PORT, () => {
  console.log(`Server ${PORT} portda ishga tushdi`);
});

// To'xtatish signallarini qayta ishlash
process.on('SIGTERM', () => {
  server.close(() => {
    console.log('Server to\'xtatildi');
  });
});