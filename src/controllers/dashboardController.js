const db = require('../config/db');
const marketDataService = require('../services/MarketDataService');
const { getMcxBaseScrip } = require('../utils/symbolHelper');
const MarginUtils = require('../utils/MarginUtils');

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
            SELECT t.*, u.username, u.full_name, u.role as user_role, u.balance, cs.config_json as user_config
            FROM trades t
            JOIN users u ON t.user_id = u.id
            LEFT JOIN client_settings cs ON u.id = cs.user_id
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

        const MCX_LOT_SIZES = {
            'GOLD': 100, 'GOLDM': 10, 'GOLDGUINEA': 8, 'GOLDPETAL': 1,
            'SILVER': 30, 'SILVERM': 5, 'SILVERMIC': 1,
            'CRUDEOIL': 100, 'CRUDEOILM': 10,
            'NATURALGAS': 1250, 'NATGASMINI': 250,
            'COPPER': 2500,
            'ZINC': 5000, 'ZINCMINI': 1000,
            'LEAD': 5000, 'LEADMINI': 1000,
            'NICKEL': 1500, 'NICKELMINI': 100,
            'ALUMINIUM': 5000, 'ALUMINI': 1000,
            'MENTHAOIL': 360, 'COTTON': 25, 'BULLDEX': 1,
        };

        const getMultiplier = (symbol, userConfig = null) => {
            const sym = symbol.toUpperCase();

            // 1. Try User Specific Config (Dynamic from UI)
            if (userConfig && typeof userConfig === 'object') {
                const mcxLotMargins = userConfig.mcxLotMargins;
                if (mcxLotMargins) {
                    const base = getMcxBaseScrip(symbol);
                    const symTrimmed = symbol.toUpperCase().replace(/\d+.*/, '');

                    const configLot = mcxLotMargins[symbol] || mcxLotMargins[base] || mcxLotMargins[symTrimmed];
                    if (configLot && typeof configLot === 'object' && configLot.LOT) {
                        const lot = parseFloat(configLot.LOT);
                        if (lot > 0) return lot;
                    }
                }
            }

            // 2. Try Scrip Data Table (PRIMARY - has all instruments from Kite API)
            if (lotMap[sym] && lotMap[sym] > 0) return lotMap[sym];

            const base = getMcxBaseScrip(symbol);
            if (base && lotMap[base.toUpperCase()] && lotMap[base.toUpperCase()] > 0) return lotMap[base.toUpperCase()];

            // 3. Try Hardcoded MCX_LOT_SIZES
            if (base && MCX_LOT_SIZES[base]) return MCX_LOT_SIZES[base];
            if (MCX_LOT_SIZES[sym]) return MCX_LOT_SIZES[sym];

            return 1; // Default fallback
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

            // Parse user config if available
            let userConfig = null;
            if (trade.user_config) {
                try {
                    userConfig = typeof trade.user_config === 'string' ? JSON.parse(trade.user_config) : trade.user_config;
                } catch (e) {
                    console.error('Failed to parse user config for P/L calculation:', e);
                }
            }

            const lotSize = getMultiplier(trade.symbol, userConfig);
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

                // Use BID for BUY trades (exit by selling) and ASK for SELL trades (exit by buying)
                const exitPrice = isBuy
                    ? (liveData?.bid || liveData?.ltp || entryPrice)
                    : (liveData?.ask || liveData?.ltp || entryPrice);

                const unrealizedPnl = isBuy
                    ? (exitPrice - entryPrice) * qty * lotSize
                    : (entryPrice - exitPrice) * qty * lotSize;

                stats.profitLoss[segment] += unrealizedPnl;

                if (!clientMap[trade.user_id]) {
                    clientMap[trade.user_id] = {
                        id: trade.user_id, username: trade.username,
                        activePL: 0, activeTrades: 0, margin: 0, balance: parseFloat(trade.balance || 0)
                    };
                }
                clientMap[trade.user_id].activePL += unrealizedPnl;
                clientMap[trade.user_id].activeTrades += 1;

                // --- Dynamic Margin Calculation (matching Mobile App Portfolio) ---
                // Simple formula: Margin = HOLDING value × Quantity
                // Just like in app: dynamicHoldingMarginPerLot * qty

                const base = getMcxBaseScrip(trade.symbol);
                // Default: 1000000 for MCX/NFO, 50 for NSE Equity
                const defaultHolding = (trade.market_type === 'EQUITY') ? 50 : 1000000;
                let holdingExposure = parseFloat(userConfig?.mcxHoldingMargin || defaultHolding);

                // Try multiple key formats to find per-instrument HOLDING margin from form
                if (userConfig?.mcxLotMargins) {
                    // Try 1: exact base symbol (e.g., "GOLD")
                    if (userConfig.mcxLotMargins[base]?.HOLDING) {
                        holdingExposure = parseFloat(userConfig.mcxLotMargins[base].HOLDING);
                    }
                    // Try 2: with exchange prefix (e.g., "MCX:GOLD")
                    else if (userConfig.mcxLotMargins[`MCX:${base}`]?.HOLDING) {
                        holdingExposure = parseFloat(userConfig.mcxLotMargins[`MCX:${base}`].HOLDING);
                    }
                    // Try 3: full trade symbol (e.g., "GOLDJANFUT")
                    else if (userConfig.mcxLotMargins[trade.symbol]?.HOLDING) {
                        holdingExposure = parseFloat(userConfig.mcxLotMargins[trade.symbol].HOLDING);
                    }
                    // Try 4: symbol with exchange (e.g., "MCX:GOLDJANFUT")
                    else if (userConfig.mcxLotMargins[`MCX:${trade.symbol}`]?.HOLDING) {
                        holdingExposure = parseFloat(userConfig.mcxLotMargins[`MCX:${trade.symbol}`].HOLDING);
                    }
                    // Try 5: fuzzy match - find any key that STARTS with base symbol
                    else {
                        const matchingKey = Object.keys(userConfig.mcxLotMargins).find(
                            key => key.toUpperCase().startsWith(base.toUpperCase()) && userConfig.mcxLotMargins[key]?.HOLDING
                        );
                        if (matchingKey) {
                            holdingExposure = parseFloat(userConfig.mcxLotMargins[matchingKey].HOLDING);
                        }
                    }
                }

                const dynamicMargin = holdingExposure * qty;
                clientMap[trade.user_id].margin += dynamicMargin;
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

        const formattedClients = Object.values(clientMap).map(c => {
            const netCapital = c.balance + c.activePL;
            let shortfall = 0;
            if (c.margin > netCapital && netCapital > 0) {
                shortfall = c.margin - netCapital;
            }
            return {
                ...c,
                activePL: c.activePL.toFixed(2),
                margin: c.margin.toFixed(2),
                marginShortfall: shortfall.toFixed(2)
            };
        });

        res.json({
            clients: formattedClients,
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
        // Step 1: Try WebSocket prices (live, when market open)
        let nifty     = marketDataService.getPrice('NSE:NIFTY 50')          || {};
        let banknifty = marketDataService.getPrice('NSE:NIFTY BANK')         || {};
        let finnifty  = marketDataService.getPrice('NSE:NIFTY FIN SERVICE')  || {};

        // Step 2: If WebSocket has no data (market closed), fallback to Kite REST API
        // Kite REST returns last known closing price even when market is closed
        if (!nifty.ltp && !banknifty.ltp && !finnifty.ltp) {
            try {
                const kiteService = require('../utils/kiteService');
                if (kiteService.isAuthenticated()) {
                    const instruments = ['NSE:NIFTY 50', 'NSE:NIFTY BANK', 'NSE:NIFTY FIN SERVICE'];
                    const quotes = await kiteService.getKite().getLTP(instruments);
                    if (quotes) {
                        if (quotes['NSE:NIFTY 50'])          nifty     = { ltp: quotes['NSE:NIFTY 50'].last_price };
                        if (quotes['NSE:NIFTY BANK'])        banknifty = { ltp: quotes['NSE:NIFTY BANK'].last_price };
                        if (quotes['NSE:NIFTY FIN SERVICE']) finnifty  = { ltp: quotes['NSE:NIFTY FIN SERVICE'].last_price };
                    }
                }
            } catch (restErr) {
                console.warn('⚠️ Indices REST fallback failed:', restErr.message);
            }
        }

        const toIndex = (raw, name) => {
            const ltp = raw.ltp || 0;
            return {
                name,
                ltp,
                bid: raw.bid || ltp,
                ask: raw.ask || ltp,
                change: raw.change || 0,
                pct: raw.chg_pct || 0,
                high: raw.ohlc?.high || 0,
                low:  raw.ohlc?.low  || 0,
                open: raw.ohlc?.open || 0,
                close: raw.ohlc?.close || 0,
            };
        };

        res.json([
            toIndex(nifty,     'NIFTY 50'),
            toIndex(banknifty, 'BANK NIFTY'),
            toIndex(finnifty,  'FINNIFTY'),
        ]);
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
    getBrokerM2M: async (req, res) => {
        try {
            const brokerId = req.user.id;
            const db = require('../config/db');
            const mockEngine = require('../utils/mockEngine');
            const { getMcxBaseScrip } = require('../utils/symbolHelper');

            // 1. Get all traders under this broker
            const [traders] = await db.execute(
                'SELECT id, username, balance FROM users WHERE parent_id = ? AND role = "TRADER"',
                [brokerId]
            );

            if (!traders.length) {
                return res.json([]);
            }

            const traderIds = traders.map(t => t.id);

            // 2. Get all open trades for these traders
            const [trades] = await db.execute(
                `SELECT t.id, t.user_id, t.symbol, t.type, t.qty, t.entry_price, t.market_type,
                        u.username
                 FROM trades t
                 JOIN users u ON t.user_id = u.id
                 WHERE t.status = 'OPEN' AND t.user_id IN (${traderIds.join(',')})`,
                []
            );

            // 3. Calculate M2M for each trader
            const INSTRUMENT_META = {
                'CRUDEOIL': 100, 'NATURALGAS': 1250, 'GOLD': 100, 'GOLDM': 10,
                'SILVER': 30, 'SILVERM': 5, 'COPPER': 2500, 'ZINC': 5000,
                'NICKEL': 1500, 'LEAD': 5000, 'ALUMINIUM': 5000, 'MENTHAOIL': 360,
                'COTTON': 25, 'BULLDEX': 1, 'GOLDGUINEA': 8, 'GOLDPETAL': 1
            };

            const traderM2M = {};
            traders.forEach(t => {
                traderM2M[t.id] = {
                    user_id: t.id,
                    username: t.username,
                    live_pnl: 0,
                    active_trades: 0,
                    margin_used: 0
                };
            });

            // 4. Calculate P/L for each open trade
            for (const trade of trades) {
                let currentPrice = trade.entry_price;
                try {
                    const cleanSymbol = getMcxBaseScrip(trade.symbol);
                    const mp = mockEngine.getPrice(cleanSymbol);
                    if (mp && mp > 0) currentPrice = mp;
                } catch (_) {}

                const baseSymbol = Object.keys(INSTRUMENT_META).find(key =>
                    trade.symbol.toUpperCase().includes(key)
                );
                const multiplier = baseSymbol ? INSTRUMENT_META[baseSymbol] : 1;

                const pnl = trade.type === 'BUY'
                    ? (currentPrice - trade.entry_price) * trade.qty * multiplier
                    : (trade.entry_price - currentPrice) * trade.qty * multiplier;

                if (traderM2M[trade.user_id]) {
                    traderM2M[trade.user_id].live_pnl += pnl;
                    traderM2M[trade.user_id].active_trades += 1;
                }
            }

            // 5. Return as array
            const result = Object.values(traderM2M);
            res.json(result);
        } catch (err) {
            console.error('getBrokerM2M error:', err);
            res.status(500).json({ error: err.message });
        }
    }
};

