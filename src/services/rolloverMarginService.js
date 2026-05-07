const cron = require('node-cron');
const db = require('../config/db');
const { getMcxBaseScrip } = require('../utils/symbolHelper');
const marketDataService = require('./MarketDataService');
const kiteService = require('../utils/kiteService');

/**
 * Runs every minute — checks if it's the configured square-off time (Rollover Time)
 */
const startRolloverMarginJob = () => {
    cron.schedule('* * * * *', async () => {
        try {
            const [rules] = await db.execute('SELECT * FROM expiry_rules');
            if (!rules.length) return;

            // ⚠️ TIMEZONE FIX: Railway runs in UTC. Convert to IST (UTC+5:30) before comparing.
            const now = new Date();
            const istNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
            const currentH = istNow.getHours();
            const currentM = istNow.getMinutes();
            console.log(`[RolloverCheck] ⏰ IST Time: ${String(currentH).padStart(2,'0')}:${String(currentM).padStart(2,'0')} | UTC: ${now.toISOString()}`);

            const [allTrades] = await db.execute(`
                SELECT t.*, u.balance, cs.config_json
                FROM trades t
                JOIN users u ON t.user_id = u.id
                JOIN client_settings cs ON t.user_id = cs.user_id
                WHERE t.status = 'OPEN' AND t.is_pending = 0
            `);

            if (allTrades.length === 0) return;

            const [allUsers] = await db.execute('SELECT id, parent_id FROM users');

            for (const rule of rules) {
                const [hh, mm] = (rule.rollover_time || '23:30').split(':');
                if (parseInt(hh) !== currentH || parseInt(mm) !== currentM) continue;

                console.log(`[RolloverCheck] 🕒 Rollover time reached for Admin #${rule.user_id}`);

                const descendantIdsSet = new Set();
                const queue = [rule.user_id];
                const processed = new Set();
                while (queue.length > 0) {
                    const pid = queue.shift();
                    if (processed.has(pid)) continue;
                    processed.add(pid);
                    allUsers.filter(u => u.parent_id === pid).forEach(u => {
                        descendantIdsSet.add(u.id);
                        queue.push(u.id);
                    });
                }

                const relevantTrades = allTrades.filter(t => descendantIdsSet.has(t.user_id));
                if (relevantTrades.length === 0) continue;

                const INSTRUMENT_META = {
                    'CRUDEOIL': 100, 'NATURALGAS': 1250, 'GOLD': 100, 'GOLDM': 10,
                    'SILVER': 30, 'SILVERM': 5, 'COPPER': 2500, 'ZINC': 5000,
                    'NICKEL': 1500, 'LEAD': 5000, 'ALUMINIUM': 5000, 'MENTHAOIL': 360,
                    'COTTON': 25, 'BULLDEX': 1, 'GOLDGUINEA': 8, 'GOLDPETAL': 1,
                    'ZINCMINI': 1000, 'LEADMINI': 1000, 'NICKELMINI': 100, 'ALUMINI': 1000,
                    'CRUDEOILM': 10, 'NATGASMINI': 250, 'SILVERMIC': 1
                };

                for (const trade of relevantTrades) {
                    try {
                        const userConfig = JSON.parse(trade.config_json || '{}');
                        let totalHoldingRequired = 0;
                        const base = getMcxBaseScrip(trade.symbol);
                        const multiplier = INSTRUMENT_META[base] || 1;

                        // 🎯 Live Price Detection
                        let currentPrice = null;
                        const liveData = marketDataService.getPrice(trade.symbol) || marketDataService.getPrice(`MCX:${trade.symbol}`);
                        if (liveData) {
                            currentPrice = trade.type === 'BUY' ? (liveData.bid || liveData.ltp) : (liveData.ask || liveData.ltp);
                        }
                        
                        if (!currentPrice && kiteService.isAuthenticated()) {
                            try {
                                const kiteSym = trade.symbol.includes(':') ? trade.symbol : `MCX:${trade.symbol}`;
                                const q = await kiteService.getQuote(kiteSym);
                                const quote = q[kiteSym] || Object.values(q)[0];
                                if (quote) currentPrice = trade.type === 'BUY' ? (quote.depth?.buy?.[0]?.price || quote.last_price) : (quote.depth?.sell?.[0]?.price || quote.last_price);
                            } catch (_) {}
                        }

                        if (!currentPrice) {
                            const mockEngine = require('../utils/mockEngine');
                            currentPrice = mockEngine.getPrice(base) || trade.entry_price;
                        }

                        if (trade.market_type === 'MCX') {
                            const brokerMargins = userConfig.brokerMcxMargins || {};
                            const holdingMarginKey = `${base} HOLDING`;
                            const holdingMarginPerLot = parseFloat(brokerMargins[holdingMarginKey] || 0);
                            if (holdingMarginPerLot <= 1) continue;
                            totalHoldingRequired = holdingMarginPerLot * trade.qty;
                        } else {
                            const exposure = parseFloat(userConfig.forexConfig?.holdingMargin || 500);
                            totalHoldingRequired = (currentPrice * trade.qty) / (exposure || 1);
                        }

                        const shortfall = totalHoldingRequired - parseFloat(trade.margin_used);
                        if (shortfall <= 0) continue;

                        const userBalance = parseFloat(trade.balance);
                        if (userBalance >= shortfall) {
                            await db.execute('UPDATE users SET balance = balance - ? WHERE id = ?', [shortfall, trade.user_id]);
                            await db.execute('UPDATE trades SET margin_used = ? WHERE id = ?', [totalHoldingRequired, trade.id]);
                        } else {
                            // Force close with brokerage
                            const pnl = trade.type === 'BUY'
                                ? (currentPrice - trade.entry_price) * trade.qty * multiplier
                                : (trade.entry_price - currentPrice) * trade.qty * multiplier;

                            let brokerage = 0;
                            const bType = (userConfig.mcxBrokerageType || 'per_crore').toLowerCase();
                            if (bType === 'per_lot') {
                                const lotBrokerageMap = { ...userConfig.brokerMcxBrokerage, ...userConfig.mcxLotBrokerage };
                                const rate = parseFloat(lotBrokerageMap[base] || lotBrokerageMap[trade.symbol] || userConfig.mcxLotBrokerageDefault || 0);
                                brokerage = trade.qty * rate;
                            } else {
                                const rate = parseFloat(userConfig.mcxBrokerage || 0);
                                const turnover = (parseFloat(trade.entry_price) + parseFloat(currentPrice)) * trade.qty * multiplier;
                                brokerage = (turnover / 10000000) * rate;
                            }

                            const balanceChange = pnl - brokerage;
                            await db.execute('UPDATE trades SET status = "CLOSED", exit_price = ?, exit_time = NOW(), pnl = ?, brokerage = ?, closed_by = "ADMIN" WHERE id = ?', [currentPrice, pnl, brokerage, trade.id]);
                            await db.execute('UPDATE users SET balance = balance + ? WHERE id = ?', [balanceChange, trade.user_id]);
                        }
                    } catch (err) {
                        console.error(`[RolloverCheck] Error trade #${trade.id}:`, err.message);
                    }
                }
            }
        } catch (err) {
            console.error('[RolloverCheck] Cron error:', err.message);
        }
    });
};

module.exports = { startRolloverMarginJob };
