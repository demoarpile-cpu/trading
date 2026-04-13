const db = require('../config/db');
const mockEngine = require('../utils/mockEngine');
const { getFromCache, saveToCache } = require('../utils/cacheManager');

/**
 * Live M2M Dashboard - Calculates unrealized P/L for all open trades
 * Formula: (Current Price - Entry Price) * Qty
 * Note: Real implementation would fetch 'Current Price' from a live feed/cache.
 */
const getLiveMarket = async (req, res) => {
    try {
        // Try cache first (market data is fast changing, so short TTL)
        const cachedData = await getFromCache('market_prices');
        if (cachedData) {
            return res.json(cachedData);
        }
    } catch (e) {
        // Cache failed, continue to get live data
    }

    const prices = mockEngine.getPrices();

    // Save to cache with 30 sec TTL
    try {
        await saveToCache('market_prices', prices, 30);
    } catch (e) {
        // Cache save failed, but data still sent
    }

    res.json(prices);
};

const getClientLiveM2M = async (req, res) => {
    try {
        const userId = req.user.id;
        const role = req.user.role;

        // Try cache first
        const cacheKey = `m2m_${userId}_${role}`;
        try {
            const cachedData = await getFromCache(cacheKey);
            if (cachedData) {
                return res.json(cachedData);
            }
        } catch (e) {
            // Cache failed, continue to DB
        }

        let query = `
            SELECT t.*, u.username, u.full_name
            FROM trades t
            JOIN users u ON t.user_id = u.id
            WHERE t.status = 'OPEN'
        `;
        let params = [];

        if (role === 'TRADER') {
            // Traders see M2M of their OWN trades
            query += ' AND t.user_id = ?';
            params.push(userId);
        } else {
            // Admins/Brokers see M2M ONLY for trades THEY created
            query += ' AND t.created_by = ?';
            params.push(userId);
        }

        const [trades] = await db.execute(query, params);

        // Mocking M2M calculation (in production, use real-time market data)
        const m2mData = trades.map(trade => {
            const mockCurrentPrice = parseFloat(trade.entry_price) + (Math.random() * 10 - 5);
            const pnl = (mockCurrentPrice - parseFloat(trade.entry_price)) * trade.qty;
            return {
                ...trade,
                current_price: mockCurrentPrice.toFixed(4),
                live_pnl: pnl.toFixed(4)
            };
        });

        // Save to cache with 2 min TTL (more frequent updates than user data)
        try {
            await saveToCache(cacheKey, m2mData, 120);
        } catch (e) {
            // Cache save failed, but data still sent
        }

        res.json(m2mData);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
};

const getMarketWatch = async (req, res) => {
    try {
        // Try cache first
        const cacheKey = 'market_watch_scrips';
        try {
            const cachedData = await getFromCache(cacheKey);
            if (cachedData) {
                return res.json(cachedData);
            }
        } catch (e) {
            // Cache failed, continue
        }

        // In a real app, this would return a list of symbols and their last known prices
        const scrips = [
            { symbol: 'GOLD', name: 'Gold Future', expiry: '2026-04-05' },
            { symbol: 'SILVER', name: 'Silver Future', expiry: '2026-05-05' },
            { symbol: 'CRUDEOIL', name: 'Crude Oil', expiry: '2026-03-20' },
            { symbol: 'ALUMINIUM', name: 'Aluminium', expiry: '2026-03-31' }
        ];

        // Cache for 5 minutes (static data)
        try {
            await saveToCache(cacheKey, scrips, 300);
        } catch (e) {
            // Cache save failed, but data still sent
        }

        res.json(scrips);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
};

const getIndices = async (req, res) => {
    try {
        // Try cache first
        const cacheKey = 'market_indices';
        try {
            const cachedData = await getFromCache(cacheKey);
            if (cachedData) {
                return res.json(cachedData);
            }
        } catch (e) {
            // Cache failed, continue
        }

        const indices = [
            { name: 'NIFTY 50', ltp: '22456.20', change: '-101.30', pct: '-0.45' },
            { name: 'BANK NIFTY', ltp: '47890.15', change: '57.45', pct: '+0.12' }
        ];

        // Cache for 2 minutes (live market data)
        try {
            await saveToCache(cacheKey, indices, 120);
        } catch (e) {
            // Cache save failed, but data still sent
        }

        res.json(indices);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
};

const getWatchlist = async (req, res) => {
    try {
        // Try cache first
        const cacheKey = 'watchlist_all';
        try {
            const cachedData = await getFromCache(cacheKey);
            if (cachedData) {
                return res.json(cachedData);
            }
        } catch (e) {
            // Cache failed, continue
        }

        const prices = mockEngine.getPrices();
        const watchlist = Object.keys(prices).map((symbol, index) => ({
            id: (index + 1).toString(),
            symbol: symbol,
            name: symbol,
            category: symbol.includes('NIFTY') ? 'NSE Futures' : 'MCX Futures',
            ltp: prices[symbol],
            bid: (prices[symbol] - 0.5).toFixed(2),
            ask: (prices[symbol] + 0.5).toFixed(2),
            high: (prices[symbol] + 10).toFixed(2),
            low: (prices[symbol] - 10).toFixed(2),
            change: (Math.random() * 2 - 1).toFixed(2)
        }));

        // Cache for 1 minute (live market data updates frequently)
        try {
            await saveToCache(cacheKey, watchlist, 60);
        } catch (e) {
            // Cache save failed, but data still sent
        }

        res.json(watchlist);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
};

module.exports = { 
    getLiveMarket, 
    getClientLiveM2M, 
    getMarketWatch,
    getIndices,
    getWatchlist,
    getBrokerM2M: async (req, res) => res.json([])
};
