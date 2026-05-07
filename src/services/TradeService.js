const db = require('../config/db');
const mockEngine = require('../utils/mockEngine');
const { logAction } = require('../controllers/systemController');
const { invalidateCache } = require('../utils/cacheManager');
const kiteService = require('../utils/kiteService');

/**
 * Service to handle core Trade operations like closing and auto-squaring off.
 */
class TradeService {
    
    /**
     * Closes a single trade by its ID.
     * Reusable for manual close, auto-close, and expiry square-off.
     */
    async closeTrade(tradeId, exitPrice = null, requesterId = 0, providedPnl = null) {
        const connection = await db.getConnection();
        try {
            await connection.beginTransaction();

            // 1. Fetch trade and client settings
            const [tradeRows] = await connection.execute(
                `SELECT t.*, cs.config_json, cs.broker_id 
                 FROM trades t
                 JOIN client_settings cs ON t.user_id = cs.user_id
                 WHERE t.id = ?`,
                [tradeId]
            );

            if (tradeRows.length === 0) throw new Error('Trade not found');
            const trade = tradeRows[0];
            if (trade.status !== 'OPEN') throw new Error('Trade is already closed');

            const clientConfig = JSON.parse(trade.config_json || '{}');
            const marginToRelease = parseFloat(trade.margin_used || 0);

            // 2. Handle Pending Orders
            if (trade.is_pending == 1) {
                await connection.execute(
                    'UPDATE trades SET status = "CANCELLED", exit_price = entry_price, exit_time = NOW(), pnl = 0 WHERE id = ?',
                    [tradeId]
                );
                await connection.execute(
                    'UPDATE users SET balance = balance + ? WHERE id = ?',
                    [marginToRelease, trade.user_id]
                );
                await connection.commit();
                await logAction(requesterId || trade.user_id, 'CANCEL_TRADE', 'trades', `Cancelled pending order #${trade.id}. Margin refunded: ${marginToRelease}`);
                return { success: true, message: 'Pending order cancelled', pnl: 0 };
            }

            // 3. Normal Market Order Closure
            let lotSize = 1;
            const mType = (trade.market_type || '').toUpperCase();

            // ══════════════════════════════════════════════════════════════════
            // MCX LOT SIZE (100% Complete - DO NOT MODIFY)
            // ══════════════════════════════════════════════════════════════════
            if (mType === 'MCX') {
                const MCX_LOT_SIZES = {
                    'CRUDEOIL': 100, 'NATURALGAS': 1250, 'GOLD': 100, 'GOLDM': 10,
                    'SILVER': 30, 'SILVERM': 5, 'COPPER': 2500, 'ZINC': 5000,
                    'NICKEL': 1500, 'LEAD': 5000, 'ALUMINIUM': 5000, 'MENTHAOIL': 360,
                    'COTTON': 25, 'BULLDEX': 1, 'GOLDGUINEA': 8, 'GOLDPETAL': 1,
                    'ZINCMINI': 1000, 'LEADMINI': 1000, 'NICKELMINI': 100, 'ALUMINI': 1000,
                    'CRUDEOILM': 10, 'NATGASMINI': 250, 'SILVERMIC': 1
                };

                const baseSymbol = Object.keys(MCX_LOT_SIZES).find(key => trade.symbol.toUpperCase().includes(key));
                if (baseSymbol && MCX_LOT_SIZES[baseSymbol]) {
                    lotSize = MCX_LOT_SIZES[baseSymbol];
                    console.log(`[TradeService] MCX Lot Size: ${trade.symbol} → ${lotSize}`);
                } else {
                    lotSize = 1;
                }
            }
            // ══════════════════════════════════════════════════════════════════
            // EQUITY (NSE) LOT SIZE
            // ══════════════════════════════════════════════════════════════════
            else if (mType === 'EQUITY') {
                try {
                    // Try to get from database first
                    const [scripRows] = await connection.execute(
                        'SELECT lot_size FROM scrip_data WHERE symbol = ?',
                        [trade.symbol]
                    );

                    if (scripRows.length > 0) {
                        lotSize = parseFloat(scripRows[0].lot_size) || 1;
                        console.log(`[TradeService] EQUITY Lot Size (from DB): ${trade.symbol} → ${lotSize}`);
                    } else {
                        // Default: Equity lot size is always 1 (trading in individual shares)
                        lotSize = 1;
                        console.log(`[TradeService] EQUITY Lot Size (default): ${trade.symbol} → 1`);
                    }
                } catch (e) {
                    lotSize = 1;
                    console.error(`[TradeService] Error fetching EQUITY lot size:`, e.message);
                }
            }
            // ══════════════════════════════════════════════════════════════════
            // OTHER SEGMENTS (NFO, OPTIONS, etc.)
            // ══════════════════════════════════════════════════════════════════
            else {
                try {
                    const [scripRows] = await connection.execute(
                        'SELECT lot_size FROM scrip_data WHERE symbol = ?',
                        [trade.symbol]
                    );
                    if (scripRows.length > 0 && parseFloat(scripRows[0].lot_size) > 1) {
                        lotSize = parseFloat(scripRows[0].lot_size);
                        console.log(`[TradeService] ${mType} Lot Size (from DB): ${trade.symbol} → ${lotSize}`);
                    } else {
                        lotSize = 1;
                    }
                } catch (e) {
                    lotSize = 1;
                }
            }

            let finalExitPrice = exitPrice;
            if (!finalExitPrice || finalExitPrice <= 0) {
                const { getMcxBaseScrip } = require('../utils/symbolHelper');
                const base = getMcxBaseScrip(trade.symbol);
                const marketDataService = require('./MarketDataService');
                
                // 🎯 1. Try Memory Ticker (Multiple Prefixes)
                const searchPatterns = [trade.symbol, `MCX:${trade.symbol}`, `NFO:${trade.symbol}`, `NSE:${trade.symbol}`];
                let liveData = null;
                for (const p of searchPatterns) {
                    liveData = marketDataService.getPrice(p);
                    if (liveData) break;
                }
                
                if (liveData) {
                    finalExitPrice = trade.type === 'BUY' ? (liveData.bid || liveData.ltp) : (liveData.ask || liveData.ltp);
                    console.log(`[TradeService] Found in Ticker: ${finalExitPrice} (${trade.type === 'BUY' ? 'BID' : 'ASK'})`);
                } 
                
                // 🎯 2. Fallback to Kite API (Full Quote)
                if ((!finalExitPrice || finalExitPrice <= 0) && kiteService.isAuthenticated()) {
                    try {
                        const kiteSym = trade.symbol.includes(':') ? trade.symbol : (mType === 'MCX' ? `MCX:${trade.symbol}` : (mType === 'EQUITY' ? `NSE:${trade.symbol}` : `NFO:${trade.symbol}`));
                        console.log(`[TradeService] Fetching Live Quote from Kite: ${kiteSym}`);
                        const quoteRes = await kiteService.getQuote(kiteSym);
                        const quote = quoteRes[kiteSym] || Object.values(quoteRes)[0];
                        if (quote) {
                            finalExitPrice = trade.type === 'BUY' 
                                ? (quote.depth?.buy?.[0]?.price || quote.last_price) 
                                : (quote.depth?.sell?.[0]?.price || quote.last_price);
                            console.log(`[TradeService] Kite Quote Received: ${finalExitPrice}`);
                        }
                    } catch (e) {
                        console.error(`[TradeService] Kite Quote Error:`, e.message);
                    }
                }

                // 🎯 3. Final Fallback (Mock or Entry)
                if (!finalExitPrice || finalExitPrice <= 0) {
                    finalExitPrice = mockEngine.getPrice(base) || trade.entry_price;
                    console.log(`[TradeService] Using Fallback Price: ${finalExitPrice}`);
                }
            }

            // Use provided P/L from frontend if available (calculated at the moment of exit)
            // Otherwise calculate it based on exit price and actual_qty (for new trades with units/lots mode)
            let pnl;
            if (providedPnl !== null && providedPnl !== undefined) {
                pnl = parseFloat(providedPnl);
                console.log(`[TradeService] Using provided P/L: ${pnl}`);
            } else {
                // Use actual_qty if available (new trades with units/lots), fallback to calculated qty
                const qtyForPnl = trade.actual_qty || (trade.qty * lotSize);
                pnl = trade.type === 'BUY'
                    ? (finalExitPrice - trade.entry_price) * qtyForPnl
                    : (trade.entry_price - finalExitPrice) * qtyForPnl;
                console.log(`[TradeService] Calculated P/L using ${trade.actual_qty ? 'actual_qty' : 'qty×lotSize'}: ${pnl}`);
            }

            // 4. Calculate Brokerage & Swap
            let brokerage = 0;
            let swap = 0;
            let brokerSwapRate = 5;

            // Helper: calculate brokerage based on type
            const calcBrokerage = (brokerageVal, brokerageType, qty, exitPrice, entryPrice, multiplier = 1) => {
                const rate = Math.abs(parseFloat(brokerageVal || 0));
                if (rate <= 0) return 0;

                const type = (brokerageType || 'PER_LOT').toUpperCase();
                let result = 0;

                if (type === 'PER_LOT' || type === 'PER LOT') {
                    result = qty * rate;
                } else if (type === 'PER_CRORE' || type === 'PER CRORE') {
                    const turnover = (parseFloat(entryPrice) + parseFloat(exitPrice)) * qty * multiplier;
                    result = (turnover / 10000000) * rate;
                } else {
                    result = qty * rate;
                }

                // Ensure brokerage is never negative
                return Math.max(0, result);
            };

            // Clean symbol (remove exchange prefix like "MCX:" and handle formats like GOLD26JUNFUT)
            let rawSymbol = (trade.symbol || '').toUpperCase();
            let cleanSymbol = rawSymbol.includes(':') ? rawSymbol.split(':')[1] : rawSymbol;

            // Try to find scrip-specific brokerage in client_settings config
            let scripRate = undefined;

            if (mType === 'MCX') {
                // Priority based on mcxBrokerageType
                const brokerageType = (clientConfig.mcxBrokerageType || 'per_crore').toLowerCase();

                // ONLY look for scrip-specific brokerage if in per_lot mode
                if (brokerageType === 'per_lot') {
                    const lotBrokerageMap = { ...clientConfig.brokerMcxBrokerage, ...clientConfig.mcxLotBrokerage };

                    // 1. Try exact match on clean symbol
                    if (lotBrokerageMap[cleanSymbol] !== undefined) {
                        scripRate = parseFloat(lotBrokerageMap[cleanSymbol]);
                    } else {
                        // 2. Try to find if any key in map is a prefix or part of cleanSymbol
                        // Sort keys by length descending to match longest first (e.g., NATURALGAS MINI before NATURALGAS)
                        const sortedKeys = Object.keys(lotBrokerageMap).sort((a, b) => b.length - a.length);
                        for (const key of sortedKeys) {
                            if (cleanSymbol.startsWith(key.toUpperCase().replace(/\s+/g, ''))) {
                                scripRate = parseFloat(lotBrokerageMap[key]);
                                break;
                            }
                        }
                    }
                }
                // If per_crore mode, skip scrip-specific lookup and use general rate in fallback
            } else if (mType === 'EQUITY') {
                const equityMap = clientConfig.brokerEquityBrokerage || {};
                if (equityMap[cleanSymbol] !== undefined) {
                    scripRate = parseFloat(equityMap[cleanSymbol]);
                } else {
                    const sortedKeys = Object.keys(equityMap).sort((a, b) => b.length - a.length);
                    for (const key of sortedKeys) {
                        if (cleanSymbol.startsWith(key.toUpperCase())) {
                            scripRate = parseFloat(equityMap[key]);
                            break;
                        }
                    }
                }
            }

            if (scripRate !== undefined && scripRate > 0) {
                // Priority 1: Scrip-specific from config
                // Use actual_qty if available (new trades), fallback to qty
                const qtyForBrokerage = trade.actual_qty || trade.qty;
                brokerage = qtyForBrokerage * scripRate;
                console.log(`[TradeService] Scrip-specific Brokerage: Raw=${rawSymbol}, Clean=${cleanSymbol}, Rate=${scripRate}, Qty=${qtyForBrokerage}, Calculated=${brokerage.toFixed(2)}`);
            } else {
                // Priority 2: Segment Settings from user_segments
                const [segmentRows] = await connection.execute(
                    'SELECT * FROM user_segments WHERE user_id = ? AND segment = ?',
                    [trade.user_id, trade.market_type]
                );

                if (segmentRows.length > 0 && parseFloat(segmentRows[0].brokerage_value) > 0) {
                    const seg = segmentRows[0];
                    // Use actual_qty if available (includes lot multiplication already), otherwise use qty×lotSize
                    const qtyForBrokerageCalc = trade.actual_qty || trade.qty;
                    const multiplierForBrokerage = trade.actual_qty ? 1 : lotSize;
                    brokerage = calcBrokerage(seg.brokerage_value, seg.brokerage_type, qtyForBrokerageCalc, finalExitPrice, trade.entry_price, multiplierForBrokerage);
                    console.log(`[TradeService] Segment ${trade.market_type} Brokerage: Rate=${seg.brokerage_value}, Type=${seg.brokerage_type}, Qty=${qtyForBrokerageCalc}, Calculated=${brokerage.toFixed(2)}`);
                } else {
                    // Priority 3: General Fallback from client_settings
                    const qtyForClientBrokerage = trade.actual_qty || trade.qty;
                    const multiplierForClientBrokerage = trade.actual_qty ? 1 : lotSize;

                    if (mType === 'MCX') {
                        const brokerageType = (clientConfig.mcxBrokerageType || 'per_crore').toLowerCase();
                        let rate = parseFloat(clientConfig.mcxBrokerage || 0);

                        const calcType = brokerageType === 'per_lot' ? 'PER_LOT' : 'PER_CRORE';
                        brokerage = calcBrokerage(rate, calcType, qtyForClientBrokerage, finalExitPrice, trade.entry_price, multiplierForClientBrokerage);
                    } else if (mType === 'EQUITY') {
                        const rate = parseFloat(clientConfig.brokerEquityBrokerage || clientConfig.equityBrokerage || 0);
                        brokerage = calcBrokerage(rate, 'PER_LOT', qtyForClientBrokerage, finalExitPrice, trade.entry_price, multiplierForClientBrokerage);
                    } else if (mType === 'OPTIONS') {
                        let rate = 0;
                        if (cleanSymbol.includes('NIFTY') || cleanSymbol.includes('BANKNIFTY')) {
                            rate = parseFloat(clientConfig.brokerOptionsIndexBrokerage || clientConfig.optionsIndexBrokerage || 20);
                        } else if (mType === 'MCX' || cleanSymbol.includes('MCX')) {
                            rate = parseFloat(clientConfig.brokerOptionsMcxBrokerage || clientConfig.optionsMcxBrokerage || 20);
                        } else {
                            rate = parseFloat(clientConfig.brokerOptionsEquityBrokerage || clientConfig.optionsEquityBrokerage || 20);
                        }
                        brokerage = qtyForClientBrokerage * rate;
                    } else if (mType === 'COMEX') {
                        const rate = parseFloat(clientConfig.comexBrokerage || 0);
                        brokerage = calcBrokerage(rate, 'PER_LOT', qtyForClientBrokerage, finalExitPrice, trade.entry_price, multiplierForClientBrokerage);
                    } else if (mType === 'FOREX') {
                        const rate = parseFloat(clientConfig.forexBrokerage || 0);
                        brokerage = calcBrokerage(rate, 'PER_LOT', qtyForClientBrokerage, finalExitPrice, trade.entry_price, multiplierForClientBrokerage);
                    } else if (mType === 'CRYPTO') {
                        const rate = parseFloat(clientConfig.cryptoBrokerage || 0);
                        brokerage = calcBrokerage(rate, 'PER_LOT', qtyForClientBrokerage, finalExitPrice, trade.entry_price, multiplierForClientBrokerage);
                    }
                    
                    if (brokerage > 0) {
                        console.log(`[TradeService] Fallback ${mType} Brokerage Calculated: ${brokerage.toFixed(2)}`);
                    }
                }
            }

            // Calculate Swap if applicable
            if (trade.broker_id) {
                const [brokerRows] = await connection.execute('SELECT swap_rate FROM broker_shares WHERE user_id = ?', [trade.broker_id]);
                if (brokerRows.length > 0) brokerSwapRate = parseFloat(brokerRows[0].swap_rate || 5);

                const entryTime = new Date(trade.entry_time);
                const daysHeld = Math.ceil((new Date() - entryTime) / (1000 * 60 * 60 * 24));
                if ((trade.market_type === 'MCX' || trade.market_type === 'EQUITY') && daysHeld > 1) {
                    const qtyForSwap = trade.actual_qty || trade.qty;
                    swap = qtyForSwap * brokerSwapRate * (daysHeld - 1);
                }
            }

            // 5. Update Database
            const balanceChange = pnl - brokerage - swap;

            let closedByRole = 'TRADER';
            if (requesterId === 0) {
                closedByRole = 'ADMIN';
            } else {
                const [reqUserRows] = await connection.execute('SELECT role FROM users WHERE id = ?', [requesterId]);
                if (reqUserRows.length > 0 && reqUserRows[0].role !== 'TRADER') {
                    closedByRole = 'ADMIN';
                }
            }

            await connection.execute(
                'UPDATE trades SET status = "CLOSED", exit_price = ?, exit_time = NOW(), pnl = ?, brokerage = ?, swap = ?, closed_by = ? WHERE id = ?',
                [finalExitPrice, pnl, brokerage, swap, closedByRole, tradeId]
            );

            await connection.execute(
                'UPDATE users SET balance = balance + ? WHERE id = ?',
                [balanceChange, trade.user_id]
            );

            await connection.commit();

            // 6. Housekeeping (Logs & Cache)
            await logAction(requesterId || trade.user_id, 'CLOSE_TRADE', 'trades', 
                `Closed trade #${trade.id} @ ${finalExitPrice}. PnL: ${pnl.toFixed(2)}, Brokerage: ${brokerage}, Swap: ${swap}`);
            
            try {
                await invalidateCache(`m2m_${trade.user_id}_TRADER`);
                await invalidateCache(`m2m_${trade.user_id}_BROKER`);
            } catch (_) {}

            return { success: true, pnl, brokerage, swap, balanceChange };
        } catch (err) {
            await connection.rollback();
            throw err;
        } finally {
            connection.release();
        }
    }

    /**
     * Closes all open positions and cancels all pending orders for a user.
     * Used for RMS Auto-Squaring off.
     */
    async closeAllUserTrades(userId, requesterId = 0, reason = 'RMS_AUTO_CLOSE') {
        const [trades] = await db.execute(
            "SELECT id FROM trades WHERE user_id = ? AND status = 'OPEN'",
            [userId]
        );

        const results = [];
        for (const trade of trades) {
            try {
                const res = await this.closeTrade(trade.id, null, requesterId);
                results.push({ id: trade.id, success: true, ...res });
            } catch (err) {
                console.error(`[TradeService] Failed to auto-close trade #${trade.id}:`, err.message);
                results.push({ id: trade.id, success: false, error: err.message });
            }
        }

        if (results.length > 0) {
            await logAction(requesterId, reason, 'users', `Mass squared off ${results.length} trades for user #${userId}`);
        }

        return results;
    }
}

module.exports = new TradeService();
