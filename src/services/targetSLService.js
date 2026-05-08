const db = require('../config/db');
const mockEngine = require('../utils/mockEngine');

/**
 * Monitor Target & Stop Loss for all open trades
 * Runs every 5 seconds to check if target/SL is hit
 * Auto-closes trades when conditions are met
 */
const monitorTargetSL = async () => {
    try {
        // Fetch all open trades with target/SL set
        const [trades] = await db.execute(`
            SELECT t.id, t.user_id, t.symbol, t.type, t.qty, t.entry_price,
                   t.target_price, t.stop_loss, t.market_type, cs.config_json
            FROM trades t
            JOIN client_settings cs ON t.user_id = cs.user_id
            WHERE t.status = 'OPEN'
            AND (t.target_price IS NOT NULL OR t.stop_loss IS NOT NULL)
        `);

        if (trades.length === 0) return;

        console.log(`[TargetSL] Monitoring ${trades.length} trades with target/SL...`);

        for (const trade of trades) {
            try {
                // Get current live price from MarketDataService
                const marketDataService = require('./MarketDataService');
                const cleanSymbol = trade.symbol.includes(':') ? trade.symbol.split(':')[1] : trade.symbol;
                const marketType = (trade.market_type || 'MCX').toUpperCase();
                const prefix = marketType === 'EQUITY' ? 'NSE' : (marketType === 'OPTIONS' ? 'NFO' : marketType);
                
                let livePrice = null;
                const possibleSymbols = [trade.symbol, `${prefix}:${cleanSymbol}`, cleanSymbol];
                for (const s of possibleSymbols) {
                    const data = marketDataService.getPrice(s);
                    if (data && data.ltp) {
                        livePrice = data.ltp;
                        break;
                    }
                }

                let currentPrice = livePrice || trade.entry_price;

                // Check TARGET HIT (Profit scenario)
                if (trade.target_price) {
                    let targetHit = false;

                    if (trade.type === 'BUY' && currentPrice >= trade.target_price) {
                        targetHit = true;
                    } else if (trade.type === 'SELL' && currentPrice <= trade.target_price) {
                        targetHit = true;
                    }

                    if (targetHit) {
                        console.log(`[TargetSL] ✅ TARGET HIT - Trade #${trade.id} (${trade.symbol}) at ${currentPrice}`);
                        await autoCloseTrade(trade, trade.target_price, 'TARGET_HIT');
                        continue;
                    }
                }

                // Check STOP LOSS HIT (Loss scenario)
                if (trade.stop_loss) {
                    let slHit = false;

                    if (trade.type === 'BUY' && currentPrice <= trade.stop_loss) {
                        slHit = true;
                    } else if (trade.type === 'SELL' && currentPrice >= trade.stop_loss) {
                        slHit = true;
                    }

                    if (slHit) {
                        console.log(`[TargetSL] ❌ STOP LOSS HIT - Trade #${trade.id} (${trade.symbol}) at ${currentPrice}`);
                        await autoCloseTrade(trade, trade.stop_loss, 'SL_HIT');
                        continue;
                    }
                }
            } catch (tradeErr) {
                console.error(`[TargetSL] Error processing trade #${trade.id}:`, tradeErr.message);
            }
        }
    } catch (err) {
        console.error('[TargetSL] Monitor error:', err.message);
    }
};

/**
 * Auto-close trade when target/SL is hit
 */
const autoCloseTrade = async (trade, exitPrice, reason) => {
    try {
        const INSTRUMENT_META = {
            'GOLD': { multiplier: 100 },
            'GOLDM': { multiplier: 10 },
            'SILVER': { multiplier: 30 },
            'SILVERM': { multiplier: 5 },
            'CRUDEOIL': { multiplier: 100 },
            'CRUDEOILM': { multiplier: 10 },
            'COPPER': { multiplier: 2500 },
            'COPPERM': { multiplier: 250 },
            'NICKEL': { multiplier: 1500 },
            'ZINC': { multiplier: 5000 },
            'ZINCMINI': { multiplier: 1000 },
            'LEAD': { multiplier: 5000 },
            'LEADMINI': { multiplier: 1000 },
            'ALUMINIUM': { multiplier: 5000 },
            'ALUMINIUMM': { multiplier: 1000 },
            'NATURALGAS': { multiplier: 1250 },
            'NATURALGASM': { multiplier: 125 }
        };

        const symbol = trade.symbol.split('26')[0] || trade.symbol.split('25')[0] || trade.symbol;
        const multiplier = INSTRUMENT_META[symbol]?.multiplier || 1;

        // Calculate P/L
        let pnl;
        if (trade.type === 'BUY') {
            pnl = (exitPrice - trade.entry_price) * trade.qty * multiplier;
        } else {
            pnl = (trade.entry_price - exitPrice) * trade.qty * multiplier;
        }

        // Fetch brokerage and swap
        const [tradeDetails] = await db.execute(
            'SELECT brokerage, swap FROM trades WHERE id = ?',
            [trade.id]
        );

        const brokerage = tradeDetails[0]?.brokerage || 0;
        const swap = tradeDetails[0]?.swap || 0;

        // Calculate balance change
        const balanceChange = pnl - brokerage - swap;

        // Close the trade
        await db.execute(
            `UPDATE trades SET status = 'CLOSED', exit_price = ?, pnl = ?, exit_time = NOW(), closed_by = 'ADMIN' WHERE id = ?`,
            [exitPrice, pnl, trade.id]
        );

        // Update user balance
        await db.execute(
            'UPDATE users SET balance = balance + ? WHERE id = ?',
            [balanceChange, trade.user_id]
        );

        console.log(`[TargetSL] ✅ Trade #${trade.id} closed | P/L: ₹${pnl.toFixed(2)} | Reason: ${reason}`);
    } catch (err) {
        console.error(`[TargetSL] Error closing trade #${trade.id}:`, err.message);
    }
};

/**
 * Start the monitoring service
 * Checks every 5 seconds
 */
const startTargetSLMonitoring = () => {
    setInterval(() => {
        monitorTargetSL().catch(err => console.error('[TargetSL] Service error:', err));
    }, 5000); // Check every 5 seconds

    console.log('[TargetSL] 🚀 Auto Target/SL monitoring service started (5s interval)');
};

module.exports = { startTargetSLMonitoring, monitorTargetSL };
