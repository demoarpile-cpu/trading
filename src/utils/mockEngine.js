const EventEmitter = require('events');

class MockMarketEngine extends EventEmitter {
    constructor() {
        super();
        this.prices = {
            'GOLD': 72540.00,
            'SILVER': 89420.00,
            'CRUDEOIL': 6540.00,
            'ALUMINIUM': 212.45,
            'NIFTY': 22450.00,
            'BANKNIFTY': 47800.00
        };
        this.startEngine();
    }

    startEngine() {
        setInterval(() => {
            Object.keys(this.prices).forEach(symbol => {
                const volatility = symbol.includes('NIFTY') ? 2.0 : 5.0;
                const change = (Math.random() * volatility - (volatility / 2));
                this.prices[symbol] = parseFloat((this.prices[symbol] + change).toFixed(2));
            });
            this.emit('update', this.prices);
        }, 1000);
    }

    getPrices() {
        return this.prices;
    }

    getPrice(symbol) {
        // ✅ First try exact match
        if (this.prices[symbol]) {
            return this.prices[symbol];
        }

        // ✅ If not found, try extracting base symbol (e.g., "GOLD26JUN" → "GOLD")
        const baseSymbol = symbol.replace(/\d+[A-Z]*$/g, '').trim(); // Remove date suffixes like "26JUN"
        if (baseSymbol && baseSymbol !== symbol && this.prices[baseSymbol]) {
            console.log(`[MockEngine] 📌 Symbol "${symbol}" → using base "${baseSymbol}" price ₹${this.prices[baseSymbol]}`);
            return this.prices[baseSymbol];
        }

        // ✅ If still not found, create a mock price for the symbol
        const basePrice = (Math.random() * 2000) + 100; // randomish start
        this.prices[symbol] = parseFloat(basePrice.toFixed(2));
        return this.prices[symbol];
    }
}

const engine = new MockMarketEngine();
module.exports = engine;
//   test this 