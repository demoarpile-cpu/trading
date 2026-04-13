const { KiteTicker } = require('kiteconnect');
const kiteAuthService = require('./KiteAuthService');
const socketManager = require('../websocket/SocketManager');
const EventEmitter = require('events');

// ── Twelve Data config for Crypto + Forex ──
const TWELVE_DATA_KEY = process.env.TWELVE_DATA_API_KEY || 'demo';
const TWELVE_BASE = 'https://api.twelvedata.com';

const CRYPTO_SYMBOLS = 'BTC/USD,ETH/USD,BNB/USD,SOL/USD,XRP/USD,ADA/USD,DOGE/USD,DOT/USD,MATIC/USD,AVAX/USD';
const FOREX_SYMBOLS = 'XAU/USD,XAG/USD,USD/INR,EUR/INR,GBP/USD,USD/JPY,USD/CHF,AUD/CAD,EUR/USD,GBP/INR';

const SYMBOL_META = {
    'BTC/USD': { name: 'Bitcoin', category: 'crypto' },
    'ETH/USD': { name: 'Ethereum', category: 'crypto' },
    'BNB/USD': { name: 'BNB', category: 'crypto' },
    'SOL/USD': { name: 'Solana', category: 'crypto' },
    'XRP/USD': { name: 'Ripple', category: 'crypto' },
    'ADA/USD': { name: 'Cardano', category: 'crypto' },
    'DOGE/USD': { name: 'Dogecoin', category: 'crypto' },
    'DOT/USD': { name: 'Polkadot', category: 'crypto' },
    'MATIC/USD': { name: 'Polygon', category: 'crypto' },
    'AVAX/USD': { name: 'Avalanche', category: 'crypto' },
    'XAU/USD': { name: 'Gold', category: 'commodity' },
    'XAG/USD': { name: 'Silver', category: 'commodity' },
    'USD/INR': { name: 'USD/INR', category: 'forex' },
    'EUR/INR': { name: 'EUR/INR', category: 'forex' },
    'GBP/USD': { name: 'GBP/USD', category: 'forex' },
    'USD/JPY': { name: 'USD/JPY', category: 'forex' },
    'USD/CHF': { name: 'USD/CHF', category: 'forex' },
    'AUD/CAD': { name: 'AUD/CAD', category: 'forex' },
    'EUR/USD': { name: 'EUR/USD', category: 'forex' },
    'GBP/INR': { name: 'GBP/INR', category: 'forex' },
};

/**
 * Service to manage real-time market data from Zerodha + Twelve Data.
 * Handles single master connection or per-user connection if needed.
 * Broadcasts all price updates via Socket.IO.
 */
class MarketDataService extends EventEmitter {
    constructor() {
        super();
        this.ticker = null;
        this.prices = {};
        this.subscribedTokens = new Set();
        this.instrumentMap = {}; // token -> symbol
        this.isConnecting = false;

        // Crypto + Forex state
        this.cryptoPrices = {};
        this.forexPrices = {};
        this.cryptoInterval = null;
        this.forexInterval = null;
    }

    async init(userId) {
        if (this.ticker || this.isConnecting) return;
        this.isConnecting = true;

        try {
            const repo = require('../repositories/KiteRepository');
            const userSession = await repo.getSessionByUserId(userId);

            if (!userSession || !userSession.access_token) {
                console.log('⚠️  Kite credentials not available for user ' + userId + ', falling back to mock engine');
                this.startMockEngine();
                this.isConnecting = false;
                return;
            }

            this.ticker = new KiteTicker({
                api_key: process.env.KITE_API_KEY,
                access_token: userSession.access_token
            });

            this.ticker.autoReconnect(true, 50, 5);

            this.ticker.on('connect', () => {
                console.log('📈 Zerodha Ticker Connected');
                this.stopMockEngine();
                this.resubscribe();
            });

            this.ticker.on('ticks', (ticks) => {
                this.handleTicks(ticks);
            });

            this.ticker.on('error', (err) => {
                console.error('⚠️  Ticker Error:', err.message);
                // 403, 401, connection errors → switch to mock
                if (err.message?.includes('403') || err.message?.includes('401') || err.message?.includes('connection')) {
                    console.log('🧪 Switching to mock engine due to:', err.message);
                    this.startMockEngine();
                }
            });

            this.ticker.on('disconnect', () => {
                console.warn('⚠️  Ticker disconnected, using mock engine');
                this.startMockEngine();
            });

            this.ticker.connect();
        } catch (err) {
            console.error('⚠️  Ticker init failed:', err.message);
            this.startMockEngine();
        } finally {
            this.isConnecting = false;
        }
    }

    startMockEngine() {
        if (this.mockInterval) return;
        console.log('🧪 Starting Mock Price Engine');
        this.mockInterval = setInterval(() => {
            const updates = {};
            const io = socketManager.getIo();

            // Simulate some volatility for subscribed instruments
            this.subscribedTokens.forEach(token => {
                const symbol = this.instrumentMap[token] || `TOKEN_${token}`;
                let current = this.prices[symbol]?.ltp || 1000;
                const change = (Math.random() - 0.5) * (current * 0.001); // 0.1% volatility
                const newPrice = current + change;

                const data = {
                    symbol,
                    ltp: parseFloat(newPrice.toFixed(2)),
                    change: parseFloat(change.toFixed(2)),
                    volume: (this.prices[symbol]?.volume || 1000) + Math.floor(Math.random() * 10),
                    ohlc: this.prices[symbol]?.ohlc || { open: newPrice, high: newPrice, low: newPrice, close: newPrice }
                };

                this.prices[symbol] = data;
                updates[symbol] = data;
            });

            if (io && Object.keys(updates).length > 0) {
                io.emit('price_update', updates);
            }
        }, 1000);
    }

    stopMockEngine() {
        if (this.mockInterval) {
            clearInterval(this.mockInterval);
            this.mockInterval = null;
            console.log('🧪 Stopped Mock Price Engine');
        }
    }

    handleTicks(ticks) {
        const io = socketManager.getIo();
        const updates = {};

        ticks.forEach(tick => {
            const info = this.instrumentMap[tick.instrument_token];
            const symbol = info || tick.instrument_token;
            
            const data = {
                symbol,
                ltp: tick.last_price,
                change: tick.net_change || 0,
                volume: tick.volume_traded || 0,
                ohlc: tick.ohlc || {},
                depth: tick.depth || {}
            };

            this.prices[symbol] = data;
            updates[symbol] = data;
        });

        if (io) {
            io.emit('price_update', updates);
        }
        this.emit('update', updates);
    }

    subscribe(symbol, token) {
        if (!token) return;
        this.instrumentMap[token] = symbol;
        this.subscribedTokens.add(token);
        
        if (this.ticker && this.ticker.connected) {
            this.ticker.subscribe([token]);
            this.ticker.setMode(this.ticker.modeFull, [token]);
        } else if (!this.ticker) {
            // If ticker not active, ensure mock engine starts or resumes
            this.startMockEngine();
        }
    }

    resubscribe() {
        if (!this.ticker || !this.ticker.connected) return;
        const tokens = Array.from(this.subscribedTokens);
        if (tokens.length > 0) {
            this.ticker.subscribe(tokens);
            this.ticker.setMode(this.ticker.modeFull, tokens);
            console.log(`📊 Resubscribed to ${tokens.length} instruments`);
        }
    }

    getPrice(symbol) {
        return this.prices[symbol];
    }

    shutdown() {
        if (this.ticker) {
            this.ticker.disconnect();
            this.ticker = null;
            console.log('📉 Ticker Shutdown');
        }
        this.stopCryptoForex();
    }

    // ══════════════════════════════════════════════════════
    //   CRYPTO + FOREX (Twelve Data) — separate intervals
    // ══════════════════════════════════════════════════════

    startCryptoForex() {
        if (this.cryptoInterval) return;
        console.log('🌐 Starting Crypto + Forex data feeds');

        // Crypto: fetch every 3 seconds
        this.cryptoInterval = setInterval(() => this._fetchTwelveData(CRYPTO_SYMBOLS, 'crypto'), 3000);
        // Forex: fetch every 5 seconds
        this.forexInterval = setInterval(() => this._fetchTwelveData(FOREX_SYMBOLS, 'forex'), 5000);

        // Immediate first fetch
        this._fetchTwelveData(CRYPTO_SYMBOLS, 'crypto');
        this._fetchTwelveData(FOREX_SYMBOLS, 'forex');
    }

    stopCryptoForex() {
        if (this.cryptoInterval) { clearInterval(this.cryptoInterval); this.cryptoInterval = null; }
        if (this.forexInterval) { clearInterval(this.forexInterval); this.forexInterval = null; }
    }

    async _fetchTwelveData(symbols, type) {
        try {
            const url = `${TWELVE_BASE}/price?symbol=${symbols}&apikey=${TWELVE_DATA_KEY}`;
            const response = await fetch(url);
            const data = await response.json();

            const io = socketManager.getIo();
            const updates = {};
            const store = type === 'crypto' ? this.cryptoPrices : this.forexPrices;

            // Parse response — multi-symbol returns { "BTC/USD": { price: "..." } }
            if (data.price) {
                // Single symbol
                const sym = symbols.split(',')[0];
                const price = parseFloat(data.price);
                const prev = store[sym]?.ltp || price;
                const change = price - prev;
                const meta = SYMBOL_META[sym] || { name: sym, category: type };

                const entry = {
                    symbol: sym, name: meta.name, category: meta.category, type,
                    ltp: price, change: parseFloat(change.toFixed(6)),
                    chg_pct: prev ? ((change / prev) * 100).toFixed(4) : '0.00',
                    direction: change > 0 ? 'up' : change < 0 ? 'down' : 'neutral',
                };
                store[sym] = entry;
                updates[`${type}:${sym}`] = entry;
            } else {
                for (const [sym, val] of Object.entries(data)) {
                    if (!val || !val.price) continue;
                    const price = parseFloat(val.price);
                    const prev = store[sym]?.ltp || price;
                    const change = price - prev;
                    const meta = SYMBOL_META[sym] || { name: sym, category: type };

                    const entry = {
                        symbol: sym, name: meta.name, category: meta.category, type,
                        ltp: price, change: parseFloat(change.toFixed(6)),
                        chg_pct: prev ? ((change / prev) * 100).toFixed(4) : '0.00',
                        direction: change > 0 ? 'up' : change < 0 ? 'down' : 'neutral',
                    };
                    store[sym] = entry;
                    updates[`${type}:${sym}`] = entry;
                }
            }

            // Broadcast via same WebSocket event
            if (io && Object.keys(updates).length > 0) {
                io.emit('market_data_update', { type, data: Object.values(updates), timestamp: new Date().toISOString() });
            }
        } catch (err) {
            // Silent fail — don't spam console on rate limits
            if (!err.message?.includes('429')) {
                console.warn(`Twelve Data (${type}) error:`, err.message);
            }
        }
    }

    // Get cached crypto/forex data (for REST fallback)
    getCryptoPrices() { return Object.values(this.cryptoPrices); }
    getForexPrices() { return Object.values(this.forexPrices); }
}

module.exports = new MarketDataService();
