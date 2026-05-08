const db = require('./src/config/db');
db.execute('SELECT id, symbol, market_type, type, qty, entry_price, status FROM trades WHERE status = "OPEN" LIMIT 10')
  .then(([r]) => { console.log(JSON.stringify(r, null, 2)); process.exit(0); })
  .catch(e => { console.error(e.message); process.exit(1); });
