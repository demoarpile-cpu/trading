const express = require('express');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

const TWELVE_DATA_KEY = process.env.TWELVE_DATA_API_KEY || 'demo';
const BASE_URL = 'https://api.twelvedata.com';

// ── Predefined symbol lists (STRICT) ──
const CRYPTO_SYMBOLS = 'BTC/USD,ETH/USD,BNB/USD,SOL/USD,XRP/USD,ADA/USD,DOGE/USD,DOT/USD,MATIC/USD,AVAX/USD';
const FOREX_SYMBOLS = 'XAU/USD,XAG/USD,USD/INR,EUR/INR,GBP/USD,USD/JPY,USD/CHF,AUD/CAD,EUR/USD,GBP/INR';

// ── Cache: per-type, short TTL to avoid rate limits ──
const cache = {};
const CACHE_TTL = 5000; // 5 seconds (Twelve Data free = 8 calls/min)

// Symbol metadata for UI
const SYMBOL_META = {
    // Crypto
    'BTC/USD':  { name: 'Bitcoin',      icon: '₿', category: 'crypto' },
    'ETH/USD':  { name: 'Ethereum',     icon: 'Ξ', category: 'crypto' },
    'BNB/USD':  { name: 'BNB',          icon: 'B', category: 'crypto' },
    'SOL/USD':  { name: 'Solana',       icon: 'S', category: 'crypto' },
    'XRP/USD':  { name: 'Ripple',       icon: 'X', category: 'crypto' },
    'ADA/USD':  { name: 'Cardano',      icon: 'A', category: 'crypto' },
    'DOGE/USD': { name: 'Dogecoin',     icon: 'D', category: 'crypto' },
    'DOT/USD':  { name: 'Polkadot',     icon: '●', category: 'crypto' },
    'MATIC/USD':{ name: 'Polygon',      icon: 'M', category: 'crypto' },
    'AVAX/USD': { name: 'Avalanche',    icon: 'A', category: 'crypto' },
    // Forex / Commodities
    'XAU/USD':  { name: 'Gold',         icon: '🥇', category: 'commodity' },
    'XAG/USD':  { name: 'Silver',       icon: '🥈', category: 'commodity' },
    'USD/INR':  { name: 'USD/INR',      icon: '₹', category: 'forex' },
    'EUR/INR':  { name: 'EUR/INR',      icon: '€', category: 'forex' },
    'GBP/USD':  { name: 'GBP/USD',      icon: '£', category: 'forex' },
    'USD/JPY':  { name: 'USD/JPY',      icon: '¥', category: 'forex' },
    'USD/CHF':  { name: 'USD/CHF',      icon: 'Fr', category: 'forex' },
    'AUD/CAD':  { name: 'AUD/CAD',      icon: 'A$', category: 'forex' },
    'EUR/USD':  { name: 'EUR/USD',      icon: '€', category: 'forex' },
    'GBP/INR':  { name: 'GBP/INR',      icon: '£', category: 'forex' },
};

// ── Fetch from Twelve Data with caching ──
async function fetchTwelveData(symbols, type) {
    const now = Date.now();
    if (cache[type] && (now - cache[type].time) < CACHE_TTL) {
        return cache[type].data;
    }

    try {
        const url = `${BASE_URL}/price?symbol=${symbols}&apikey=${TWELVE_DATA_KEY}`;
        const response = await fetch(url);
        const data = await response.json();

        // Twelve Data returns { "BTC/USD": { price: "..." }, ... } for multiple symbols
        // Or { price: "..." } for single symbol
        let parsed;
        if (data.price) {
            // Single symbol response
            const sym = symbols.split(',')[0];
            parsed = { [sym]: { price: parseFloat(data.price) } };
        } else {
            parsed = {};
            for (const [sym, val] of Object.entries(data)) {
                if (val && val.price) {
                    parsed[sym] = { price: parseFloat(val.price) };
                }
            }
        }

        cache[type] = { data: parsed, time: now };
        return parsed;
    } catch (err) {
        console.error(`Twelve Data fetch error (${type}):`, err.message);
        // Return stale cache if available
        if (cache[type]) return cache[type].data;
        return {};
    }
}

// Previous prices for change calculation
const prevPrices = {};

function buildResponse(rawData, type) {
    const result = [];
    for (const [symbol, data] of Object.entries(rawData)) {
        const price = data.price || 0;
        const prev = prevPrices[symbol] || price;
        const change = price - prev;
        const changePct = prev ? ((change / prev) * 100).toFixed(4) : '0.00';

        // Update previous price
        prevPrices[symbol] = price;

        const meta = SYMBOL_META[symbol] || { name: symbol, icon: '?', category: type };
        result.push({
            symbol,
            name: meta.name,
            icon: meta.icon,
            category: meta.category,
            price,
            change: parseFloat(change.toFixed(6)),
            changePct: parseFloat(changePct),
            direction: change > 0 ? 'up' : change < 0 ? 'down' : 'neutral',
            updatedAt: new Date().toISOString(),
        });
    }
    return result;
}

// ── REST endpoints — serve from MarketDataService cache (no fresh API call) ──
const marketDataService = require('../services/MarketDataService');

// ── GET /api/market-data/crypto ──
router.get('/crypto', authMiddleware, async (req, res) => {
    try {
        // Serve from MarketDataService in-memory cache (populated by background intervals)
        const cached = marketDataService.getCryptoPrices();
        if (cached.length > 0) {
            return res.json({ status: 'success', type: 'crypto', count: cached.length, timestamp: new Date().toISOString(), data: cached });
        }
        // Fallback: direct fetch if service hasn't populated yet
        const data = await fetchTwelveData(CRYPTO_SYMBOLS, 'crypto');
        res.json({ status: 'success', type: 'crypto', count: Object.keys(data).length, timestamp: new Date().toISOString(), data: buildResponse(data, 'crypto') });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// ── GET /api/market-data/forex ──
router.get('/forex', authMiddleware, async (req, res) => {
    try {
        const cached = marketDataService.getForexPrices();
        if (cached.length > 0) {
            return res.json({ status: 'success', type: 'forex', count: cached.length, timestamp: new Date().toISOString(), data: cached });
        }
        const data = await fetchTwelveData(FOREX_SYMBOLS, 'forex');
        res.json({ status: 'success', type: 'forex', count: Object.keys(data).length, timestamp: new Date().toISOString(), data: buildResponse(data, 'forex') });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// ── GET /api/market-data/all — Both in one call ──
router.get('/all', authMiddleware, async (req, res) => {
    try {
        const crypto = marketDataService.getCryptoPrices();
        const forex = marketDataService.getForexPrices();
        if (crypto.length > 0 || forex.length > 0) {
            return res.json({ status: 'success', timestamp: new Date().toISOString(), crypto, forex });
        }
        // Fallback
        const [c, f] = await Promise.all([
            fetchTwelveData(CRYPTO_SYMBOLS, 'crypto'),
            fetchTwelveData(FOREX_SYMBOLS, 'forex'),
        ]);
        res.json({ status: 'success', timestamp: new Date().toISOString(), crypto: buildResponse(c, 'crypto'), forex: buildResponse(f, 'forex') });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

module.exports = router;
