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
        if (!this.prices[symbol]) {
            // Add symbol if missing, so it gets mocked henceforth
            const basePrice = (Math.random() * 2000) + 100; // randomish start
            this.prices[symbol] = parseFloat(basePrice.toFixed(2));
        }
        return this.prices[symbol];
    }
}

const engine = new MockMarketEngine();
module.exports = engine;
//   test this 