const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

// Asosiy route
app.get('/', (req, res) => {
  res.send('Telegram bot ishlayapti!');
});

// Serverni ishga tushirish
app.listen(PORT, () => {
  console.log(`Server ${PORT} portda ishga tushdi`);
});