const marketDataService = require('./src/services/MarketDataService');

setTimeout(() => {
  console.log('All price keys:');
  const keys = Object.keys(marketDataService.prices);
  keys.forEach(k => {
    const p = marketDataService.prices[k];
    console.log(`  ${k} → ltp=${p.ltp}, bid=${p.bid}, ask=${p.ask}`);
  });
  
  // Test specific lookups
  const testKeys = [
    'NFO:NIFTY26MAYFUT',
    'NSE:NIFTY 50',
    'NFO:NIFTY26MAY',
    'MCX:GOLD26JUNFUT',
    'NSE:BAJAJ-AUTO'
  ];
  console.log('\nSpecific key lookups:');
  testKeys.forEach(k => {
    const p = marketDataService.getPrice(k);
    console.log(`  getPrice("${k}") =`, p ? `ltp=${p.ltp}` : 'null');
  });
  
  process.exit(0);
}, 3000);
