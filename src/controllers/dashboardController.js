const db = require('../config/db');
const marketDataService = require('../services/MarketDataService');
const { getMcxBaseScrip } = require('../utils/symbolHelper');

/**
 * Live Market Prices (Snapshot)
 */
const getLiveMarket = async (req, res) => {
    try {
        const prices = marketDataService.prices;
        res.json(prices);
    } catch (err) {
        console.error('getLiveMarket Error:', err);
        res.status(500).send('Server Error');
    }
};

/**
 * Superadmin Dashboard - Dynamic Implementation
 * Returns: { clients: [], stats: { buyTurnover, sellTurnover, totalTurnover, activeUsers, profitLoss, brokerage } }
 */
const getClientLiveM2M = async (req, res) => {
    try {
        const { id: userId, role } = req.user;

        // 1. Fetch all relevant trades (Non-Deleted)
        let tradeQuery = `
            SELECT t.*, u.username, u.full_name, u.role as user_role
            FROM trades t
            JOIN users u ON t.user_id = u.id
            WHERE t.status != 'DELETED'
        `;
        let tradeParams = [];

        if (role === 'SUPERADMIN') {
            // See everything
        } else if (role === 'ADMIN' || role === 'BROKER') {
            tradeQuery += ' AND (t.created_by = ? OR t.user_id = ?)';
            tradeParams.push(userId, userId);
        } else {
            tradeQuery += ' AND t.user_id = ?';
            tradeParams.push(userId);
        }

        const [trades] = await db.execute(tradeQuery, tradeParams);

        // 2. Fetch Multipliers (Lot Sizes) from scrip_data
        const [lotRows] = await db.execute('SELECT symbol, lot_size FROM scrip_data');
        const lotMap = {};
        lotRows.forEach(r => {
            lotMap[r.symbol.toUpperCase()] = parseFloat(r.lot_size || 1);
        });

        const getMultiplier = (symbol) => {
            const sym = symbol.toUpperCase();
            if (lotMap[sym]) return lotMap[sym];
            const base = getMcxBaseScrip(symbol);
            if (base && lotMap[base.toUpperCase()]) return lotMap[base.toUpperCase()];
            const parts = sym.split(':');
            const pureSym = parts[parts.length - 1];
            if (lotMap[pureSym]) return lotMap[pureSym];
            return 1;
        };

        // 3. Map for MarketDataService prefixes
        const PREFIX_MAP = {
            'EQUITY': 'NSE',
            'NFO': 'NFO',
            'MCX': 'MCX',
            'OPTIONS': 'NFO',
            'CRYPTO': 'CRYPTO',
            'FOREX': 'FOREX',
            'COMEX': 'COMEX'
        };

        const finalizedStats = {
            buyTurnover: { mcx: '0.00', nse: '0.00', options: '0.00', comex: '0.00', forex: '0.00', crypto: '0.00' },
            sellTurnover: { mcx: '0.00', nse: '0.00', options: '0.00', comex: '0.00', forex: '0.00', crypto: '0.00' },
            totalTurnover: { mcx: '0.00', nse: '0.00', options: '0.00', comex: '0.00', forex: '0.00', crypto: '0.00' },
            profitLoss: { mcx: '0.00', nse: '0.00', options: '0.00', comex: '0.00', forex: '0.00', crypto: '0.00' },
            activeUsers: { mcx: 0, nse: 0, options: 0, comex: 0, forex: 0, crypto: 0 },
            brokerage: { mcx: '0.00', nse: '0.00', options: '0.00', comex: '0.00', forex: '0.00', crypto: '0.00' },
            activeBuy: { mcx: 0, nse: 0, options: 0, comex: 0, forex: 0, crypto: 0 },
            activeSell: { mcx: 0, nse: 0, options: 0, comex: 0, forex: 0, crypto: 0 }
        };

        const stats = {
            buyTurnover: {}, sellTurnover: {}, totalTurnover: {}, activeUsers: {}, profitLoss: {}, brokerage: {},
            activeBuy: { mcx: 0, nse: 0, options: 0, comex: 0, forex: 0, crypto: 0 },
            activeSell: { mcx: 0, nse: 0, options: 0, comex: 0, forex: 0, crypto: 0 }
        };

        const segments = ['mcx', 'nse', 'options', 'comex', 'forex', 'crypto'];
        segments.forEach(s => {
            stats.buyTurnover[s] = 0; stats.sellTurnover[s] = 0; stats.totalTurnover[s] = 0;
            stats.activeUsers[s] = new Set(); stats.profitLoss[s] = 0; stats.brokerage[s] = 0;
        });

        const clientMap = {};

        trades.forEach(trade => {
            const mType = (trade.market_type || 'MCX').toUpperCase();
            let segment = mType === 'EQUITY' ? 'nse' : mType.toLowerCase();
            
            if (mType === 'NFO' || mType === 'OPTIONS') {
                const sym = trade.symbol.toUpperCase();
                if (sym.endsWith('CE') || sym.endsWith('PE') || /\d{5,}/.test(sym)) {
                    segment = 'options';
                } else {
                    segment = 'nse';
                }
            }

            const isBuy = trade.type === 'BUY';
            const qty = Math.abs(trade.qty);
            const entryPrice = parseFloat(trade.entry_price || 0);
            const lotSize = getMultiplier(trade.symbol);
            const tradeValue = entryPrice * qty * lotSize;

            if (isBuy) stats.buyTurnover[segment] += tradeValue;
            else stats.sellTurnover[segment] += tradeValue;
            stats.totalTurnover[segment] += tradeValue;

            stats.brokerage[segment] += parseFloat(trade.brokerage || 0);

            if (trade.status === 'CLOSED') {
                stats.profitLoss[segment] += parseFloat(trade.pnl || 0);
            }

            if (trade.status === 'OPEN') {
                stats.activeUsers[segment].add(trade.user_id);
                if (isBuy) stats.activeBuy[segment] += 1;
                else stats.activeSell[segment] += 1;

                const prefix = PREFIX_MAP[mType] || mType;
                let priceKey = trade.symbol.includes(':') ? trade.symbol : `${prefix}:${trade.symbol}`;

                const liveData = marketDataService.getPrice(priceKey);
                const currentPrice = (liveData && liveData.ltp) ? liveData.ltp : entryPrice;
                
                const unrealizedPnl = (isBuy 
                    ? (currentPrice - entryPrice) 
                    : (entryPrice - currentPrice)) * qty * lotSize;

                stats.profitLoss[segment] += unrealizedPnl;

                if (!clientMap[trade.user_id]) {
                    clientMap[trade.user_id] = {
                        id: trade.user_id, username: trade.username,
                        activePL: 0, activeTrades: 0, margin: 0
                    };
                }
                clientMap[trade.user_id].activePL += unrealizedPnl;
                clientMap[trade.user_id].activeTrades += 1;
                clientMap[trade.user_id].margin += parseFloat(trade.margin_used || 0);
            }
        });

        // 5. Finalize Stats Structure
        const formatValue = (val) => `${(val / 100000).toFixed(2)} Lakhs`;
        const formatValOnly = (val) => val.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

        segments.forEach(s => {
            finalizedStats.buyTurnover[s] = formatValue(stats.buyTurnover[s]);
            finalizedStats.sellTurnover[s] = formatValue(stats.sellTurnover[s]);
            finalizedStats.totalTurnover[s] = formatValue(stats.totalTurnover[s]);
            finalizedStats.profitLoss[s] = formatValOnly(stats.profitLoss[s]);
            finalizedStats.brokerage[s] = formatValOnly(stats.brokerage[s]);
            finalizedStats.activeUsers[s] = stats.activeUsers[s].size.toString();
            finalizedStats.activeBuy[s] = stats.activeBuy[s].toString();
            finalizedStats.activeSell[s] = stats.activeSell[s].toString();
        });

        res.json({
            clients: Object.values(clientMap).map(c => ({
                ...c,
                activePL: c.activePL.toFixed(2),
                margin: c.margin.toFixed(2)
            })),
            stats: finalizedStats
        });

    } catch (err) {
        console.error('getClientLiveM2M Error:', err);
        res.status(500).send('Server Error');
    }
};

const getMarketWatch = async (req, res) => {
    try {
        const [scrips] = await db.execute('SELECT * FROM scrip_data WHERE status = "OPEN"');
        res.json(scrips);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
};

const getIndices = async (req, res) => {
    try {
        const nifty = marketDataService.getPrice('NSE:NIFTY 50') || { ltp: 0, change: 0, chg_pct: 0 };
        const banknifty = marketDataService.getPrice('NSE:NIFTY BANK') || { ltp: 0, change: 0, chg_pct: 0 };
        
        const indices = [
            { name: 'NIFTY 50', ltp: nifty.ltp, change: nifty.change, pct: nifty.chg_pct },
            { name: 'BANK NIFTY', ltp: banknifty.ltp, change: banknifty.change, pct: banknifty.chg_pct }
        ];

        res.json(indices);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
};

const getWatchlist = async (req, res) => {
    try {
        const prices = marketDataService.prices;
        const watchlist = Object.keys(prices).map((symbol, index) => {
            const data = prices[symbol];
            return {
                id: (index + 1).toString(),
                symbol: symbol,
                name: symbol.split(':')[1] || symbol,
                category: data.type || 'NSE',
                ltp: data.ltp,
                bid: data.bid,
                ask: data.ask,
                change: data.chg_pct || 0
            };
        });
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

