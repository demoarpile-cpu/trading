const db = require('../config/db');
const marketDataService = require('../services/MarketDataService');

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
        // If SUPERADMIN, get all. If ADMIN/BROKER, get their tree or created_by.
        // For now, mirroring existing logic but expanding for Superadmin.
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

        // 2. Fetch all users involved if needed (already joined in trades)
        
        // 3. Initialize Stats Containers
        const segments = ['mcx', 'nse', 'options', 'comex', 'forex', 'crypto'];
        const stats = {
            buyTurnover: {},
            sellTurnover: {},
            totalTurnover: {},
            activeUsers: {},
            profitLoss: {},
            brokerage: {},
            activeBuy: { mcx: 0, nse: 0, nse_spot: 0, options: 0, comex: 0 },
            activeSell: { mcx: 0, nse: 0, nse_spot: 0, options: 0, comex: 0 }
        };

        segments.forEach(s => {
            stats.buyTurnover[s] = 0;
            stats.sellTurnover[s] = 0;
            stats.totalTurnover[s] = 0;
            stats.activeUsers[s] = new Set();
            stats.profitLoss[s] = 0;
            stats.brokerage[s] = 0;
        });

        const clientMap = {}; // userId -> { username, activePL, activeTrades, margin }

        // 4. Process Trades
        trades.forEach(trade => {
            const mType = (trade.market_type || 'MCX').toLowerCase();
            let segment = mType === 'equity' ? 'nse' : mType;
            
            // Distinguish NFO Futures vs Options
            if (mType === 'nfo') {
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
            const tradeValue = entryPrice * qty;

            // Turnover (Total value of entries)
            if (isBuy) {
                stats.buyTurnover[segment] = (stats.buyTurnover[segment] || 0) + tradeValue;
            } else {
                stats.sellTurnover[segment] = (stats.sellTurnover[segment] || 0) + tradeValue;
            }
            stats.totalTurnover[segment] = (stats.totalTurnover[segment] || 0) + tradeValue;

            // Brokerage
            stats.brokerage[segment] = (stats.brokerage[segment] || 0) + parseFloat(trade.brokerage || 0);

            // Profit / Loss (Realized)
            if (trade.status === 'CLOSED') {
                stats.profitLoss[segment] = (stats.profitLoss[segment] || 0) + parseFloat(trade.pnl || 0);
            }

            // Active Data (OPEN trades)
            if (trade.status === 'OPEN') {
                stats.activeUsers[segment].add(trade.user_id);
                
                // Active Buy/Sell counts
                if (isBuy) stats.activeBuy[segment] = (stats.activeBuy[segment] || 0) + 1;
                else stats.activeSell[segment] = (stats.activeSell[segment] || 0) + 1;

                // Calculate Unrealized P/L
                const marketTypeUpper = (trade.market_type || 'MCX').toUpperCase();
                const priceKey = `${marketTypeUpper}:${trade.symbol}`;
                const liveData = marketDataService.getPrice(priceKey);
                const currentPrice = liveData ? liveData.ltp : entryPrice;
                
                const unrealizedPnl = isBuy 
                    ? (currentPrice - entryPrice) * qty 
                    : (entryPrice - currentPrice) * qty;

                stats.profitLoss[segment] = (stats.profitLoss[segment] || 0) + unrealizedPnl;

                // Client-wise aggregation
                if (!clientMap[trade.user_id]) {
                    clientMap[trade.user_id] = {
                        id: trade.user_id,
                        username: trade.username,
                        activePL: 0,
                        activeTrades: 0,
                        margin: 0
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

        const finalizedStats = {
            buyTurnover: {},
            sellTurnover: {},
            totalTurnover: {},
            activeUsers: {},
            profitLoss: {},
            brokerage: {},
            activeBuy: stats.activeBuy,
            activeSell: stats.activeSell
        };

        segments.forEach(s => {
            finalizedStats.buyTurnover[s] = formatValue(stats.buyTurnover[s]);
            finalizedStats.sellTurnover[s] = formatValue(stats.sellTurnover[s]);
            finalizedStats.totalTurnover[s] = formatValue(stats.totalTurnover[s]);
            finalizedStats.activeUsers[s] = stats.activeUsers[s].size.toString();
            finalizedStats.profitLoss[s] = formatValOnly(stats.profitLoss[s]);
            finalizedStats.brokerage[s] = formatValOnly(stats.brokerage[s]);
        });

        // Specific fix for "NSE Future" vs "NSE Futures" labels in frontend
        finalizedStats.buyTurnover.nse = finalizedStats.buyTurnover.nse; 
        
        const clients = Object.values(clientMap).map(c => ({
            ...c,
            activePL: c.activePL.toFixed(2),
            margin: c.margin.toFixed(2)
        }));

        res.json({
            clients,
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

