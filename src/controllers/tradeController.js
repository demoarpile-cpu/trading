const db = require('../config/db');
const { logAction } = require('./systemController');
const mockEngine = require('../utils/mockEngine');
const bcrypt = require('bcryptjs');
const { invalidateCache } = require('../utils/cacheManager');


/**
 * Place a New Order
 */
const placeOrder = async (req, res) => {
    // Safety check: ensure req.body exists
    console.log('[placeOrder] Request received:');
    console.log('  Method:', req.method);
    console.log('  URL:', req.url);
    console.log('  Content-Type:', req.headers['content-type']);
    console.log('  Body type:', typeof req.body);
    console.log('  Body is Array:', Array.isArray(req.body));
    console.log('  Body keys:', req.body ? Object.keys(req.body) : 'N/A');
    console.log('  Body:', JSON.stringify(req.body, null, 2));

    if (!req.body || Object.keys(req.body).length === 0) {
        console.error('[placeOrder] ERROR: req.body is empty or undefined!');
        console.error('[placeOrder] Request headers:', req.headers);
        return res.status(400).json({ message: 'Request body is empty. Please check your request format.' });
    }

    const {
        symbol, type, qty, price,
        order_type = 'MARKET',
        is_pending = false,
        userId: traderId,
        transactionPassword,
        exit_price
    } = req.body;

    const requesterId = req.user.id;
    const requesterRole = req.user.role;
    const tradeIp = req.ip || req.headers['x-forwarded-for'] || '127.0.0.1';

    try {
        console.log('--- Place Order Request ---');
        console.log('Body:', JSON.stringify(req.body, null, 2));
        console.log('Incoming types:', { symbol: typeof symbol, type: typeof type, qtyType: typeof qty, qtyValue: qty });

        // 1. Basic Field Validation
        // Accept numeric strings for qty; treat undefined, null, or empty-string as missing
        const missing = [];
        if (!symbol) missing.push('symbol');
        if (!type) missing.push('type');
        if (qty === undefined || qty === null || qty === '') missing.push('qty');
        if (missing.length > 0) {
            return res.status(400).json({ message: 'Missing required fields: ' + missing.join(', ') });
        }

        // 2. Determine target user (Trader)
        let targetUserId = requesterId;
        if (requesterRole !== 'TRADER' && traderId) {
            targetUserId = traderId;
        }

        // 3. Validate User Exists and Get Balance/Password
        const [userRows] = await db.execute(
            'SELECT id, balance, transaction_password, role FROM users WHERE id = ?',
            [targetUserId]
        );
        const targetUser = userRows[0];
        if (!targetUser) {
            return res.status(404).json({ message: 'Target user not found' });
        }

        // 4. Validate Transaction Password for the requester
        const [requesterRows] = await db.execute(
            'SELECT transaction_password FROM users WHERE id = ?',
            [requesterId]
        );
        const requester = requesterRows[0];

        if (!requester || !requester.transaction_password) {
            return res.status(400).json({ message: 'Your transaction password is not set' });
        }

        if (!transactionPassword) {
            return res.status(400).json({ message: 'Transaction password is required' });
        }

        const isMatch = await bcrypt.compare(transactionPassword, requester.transaction_password);
        if (!isMatch) {
            return res.status(403).json({ message: 'Invalid transaction password' });
        }

        // ─── FETCH CLIENT CONFIG FOR VALIDATIONS ───────────────────────────────
        let clientConfig = {};
        try {
            const [clientSettings] = await db.execute(
                'SELECT config_json FROM client_settings WHERE user_id = ?',
                [targetUserId]
            );
            if (clientSettings.length > 0) {
                clientConfig = JSON.parse(clientSettings[0].config_json || '{}');
                console.log('[placeOrder] DEBUG - Client config loaded. banMcxLimitOrder=', clientConfig.banMcxLimitOrder);
            } else {
                console.log('[placeOrder] DEBUG - No client config found for userId:', targetUserId);
            }
        } catch (e) {
            console.error('[placeOrder] Error fetching client config:', e);
        }

        // ─── DETECT MARKET TYPE EARLY (needed for all segment-specific validations) ───
        const sym = symbol.toUpperCase();
        const MCX_SYMBOLS = ['GOLD', 'GOLDM', 'SILVER', 'SILVERM', 'CRUDEOIL', 'COPPER', 'NICKEL', 'ZINC', 'LEAD', 'ALUMINIUM', 'ALUMINI', 'NATURALGAS', 'MENTHAOIL', 'COTTON', 'BULLDEX', 'CRUDEOIL MINI', 'ZINCMINI', 'LEADMINI', 'SILVER MIC'];
        let marketType = 'MCX';
        if (MCX_SYMBOLS.some(s => sym.includes(s))) {
            marketType = 'MCX';
        } else if (sym.includes('/') || ['EURUSD', 'GBPUSD', 'USDJPY', 'XAUUSD'].some(f => sym.includes(f))) {
            marketType = 'FOREX';
        } else if (['BTC', 'ETH', 'SOL', 'USDT'].some(c => sym.includes(c))) {
            marketType = 'CRYPTO';
        } else if (['GC', 'SI', 'HG', 'CL'].some(c => sym.startsWith(c))) {
            marketType = 'COMEX';
        } else {
            marketType = 'EQUITY';
        }

        console.log('[placeOrder] DEBUG - Symbol detection: sym=' + sym + ', marketType=' + marketType);

        // Also check if scrip_data has market_type defined
        try {
            const [scripRows] = await db.execute('SELECT market_type FROM scrip_data WHERE symbol = ?', [sym]);
            if (scripRows.length > 0 && scripRows[0].market_type) {
                console.log('[placeOrder] DEBUG - Database market_type override:', scripRows[0].market_type);
                marketType = scripRows[0].market_type;
            }
        } catch (_) { /* scrip_data may not have market_type column yet */ }

        // ─── PARSE QUANTITY AND PRICE EARLY (needed for validations) ──────────────
        const qtyNum = parseInt(qty, 10);
        const currentPrice = mockEngine.getPrice(symbol);
        const executionPrice = price ? parseFloat(price) : (order_type === 'MARKET' ? currentPrice : 0);

        // Validate parsed values
        if (isNaN(executionPrice) || executionPrice <= 0) {
            return res.status(400).json({ message: 'Invalid price for the selected scrip' });
        }
        if (isNaN(qtyNum) || qtyNum <= 0) {
            return res.status(400).json({ message: 'Quantity must be a positive number' });
        }

        // ─── DEMO ACCOUNT CHECK (TIER 2) ─────────────────────────────────────
        if (clientConfig.isDemoAccount) {
            return res.status(400).json({
                message: `Trading is disabled for demo accounts. Please upgrade to a live account.`
            });
        }

        // ─── SEGMENT ENABLE/DISABLE CHECK ─────────────────────────────────────
        // Check if this segment is enabled in client config
        if (marketType === 'MCX' && clientConfig.mcxTrading === false) {
            return res.status(400).json({
                message: `MCX Trading is disabled for your account. Please enable it to trade.`
            });
        }
        if (marketType === 'EQUITY' && clientConfig.equityTrading === false) {
            return res.status(400).json({
                message: `EQUITY Trading is disabled for your account. Please enable it to trade.`
            });
        }
        if (marketType === 'OPTIONS' && clientConfig.indexOptionsTrading === false && clientConfig.equityOptionsTrading === false && clientConfig.mcxOptionsTrading === false) {
            return res.status(400).json({
                message: `OPTIONS Trading is disabled for your account. Please enable it to trade.`
            });
        }
        if (marketType === 'COMEX' && clientConfig.comexTrading === false) {
            return res.status(400).json({
                message: `COMEX Trading is disabled for your account. Please enable it to trade.`
            });
        }
        if (marketType === 'FOREX' && clientConfig.forexTrading === false) {
            return res.status(400).json({
                message: `FOREX Trading is disabled for your account. Please enable it to trade.`
            });
        }
        if (marketType === 'CRYPTO' && clientConfig.cryptoTrading === false) {
            return res.status(400).json({
                message: `CRYPTO Trading is disabled for your account. Please enable it to trade.`
            });
        }
        console.log('[placeOrder] ✅ Segment enabled check passed for:', marketType);

        // 5. Banned Limit Order Check (TIER 2 - Enhanced with EQUITY/OPTIONS/International)
        console.log('[placeOrder] DEBUG - order_type:', order_type, 'marketType:', marketType, 'banMcxLimitOrder:', clientConfig.banMcxLimitOrder);

        if (order_type !== 'MARKET') {
            console.log('[placeOrder] DEBUG - Non-MARKET order detected, checking bans...');

            // Check global ban
            if (clientConfig.banAllSegmentLimitOrder) {
                console.log('[placeOrder] Global limit order ban triggered');
                return res.status(400).json({
                    message: `Limit orders are disabled for all segments`
                });
            }

            // Check segment-specific ban (MCX)
            if (marketType === 'MCX' && clientConfig.banMcxLimitOrder) {
                console.log('[placeOrder] MCX limit order ban triggered');
                return res.status(400).json({
                    message: `Limit orders are banned for MCX segment`
                });
            }

            // Check segment-specific ban (EQUITY) - TIER 2
            if (marketType === 'EQUITY' && clientConfig.banEquityLimitOrder) {
                return res.status(400).json({
                    message: `Limit orders are banned for EQUITY segment`
                });
            }

            // Check segment-specific ban (OPTIONS) - TIER 2
            if (marketType === 'OPTIONS' && clientConfig.banOptionsLimitOrder) {
                return res.status(400).json({
                    message: `Limit orders are banned for OPTIONS segment`
                });
            }

            // Check international segment bans - TIER 2
            if (marketType === 'COMEX' && clientConfig.comexConfig?.banLimitOrder) {
                return res.status(400).json({
                    message: `Limit orders are banned for COMEX segment`
                });
            }
            if (marketType === 'FOREX' && clientConfig.forexConfig?.banLimitOrder) {
                return res.status(400).json({
                    message: `Limit orders are banned for FOREX segment`
                });
            }
            if (marketType === 'CRYPTO' && clientConfig.cryptoConfig?.banLimitOrder) {
                return res.status(400).json({
                    message: `Limit orders are banned for CRYPTO segment`
                });
            }

            // Check symbol-specific ban
            const now = new Date();
            const [bans] = await db.execute(
                'SELECT id FROM banned_limit_orders WHERE scrip_id = ? AND start_time <= ? AND end_time >= ?',
                [symbol, now, now]
            );
            if (bans.length > 0) {
                return res.status(400).json({ message: `Limit orders are banned for ${symbol} during this time period` });
            }
        }

        // ─── VALIDATE LOT SIZE LIMITS (PHASE 1) ──────────────────────────────
        // MCX lot size validation
        if (marketType === 'MCX') {
            const minLot = parseInt(clientConfig.mcxMinLot || 1);
            const maxLot = parseInt(clientConfig.mcxMaxLot || 100);

            if (qtyNum < minLot) {
                return res.status(400).json({
                    message: `Minimum lot size for MCX is ${minLot}. You entered ${qtyNum}`
                });
            }
            if (qtyNum > maxLot) {
                return res.status(400).json({
                    message: `Maximum lot size for MCX is ${maxLot}. You entered ${qtyNum}`
                });
            }

            console.log(`[placeOrder] ✅ Lot size valid: Min=${minLot}, Max=${maxLot}, Qty=${qtyNum}`);
        }

        // EQUITY lot size validation
        if (marketType === 'EQUITY') {
            const minLot = parseInt(clientConfig.equityMinLot || 1);
            const maxLot = parseInt(clientConfig.equityMaxLot || 100);

            if (qtyNum < minLot) {
                return res.status(400).json({
                    message: `Minimum lot size for Equity is ${minLot}. You entered ${qtyNum}`
                });
            }
            if (qtyNum > maxLot) {
                return res.status(400).json({
                    message: `Maximum lot size for Equity is ${maxLot}. You entered ${qtyNum}`
                });
            }
        }

        // ─── MAX LOT PER SCRIPT VALIDATION (TIER 2) ───────────────────────────
        // Check if adding this trade would exceed per-symbol lot limit
        if (marketType === 'MCX') {
            const maxLotScrip = parseInt(clientConfig.mcxMaxLotScrip || 0);
            if (maxLotScrip > 0) {
                const [openSymbolTrades] = await db.execute(
                    'SELECT COALESCE(SUM(qty), 0) as total_qty FROM trades WHERE user_id = ? AND status = "OPEN" AND symbol = ?',
                    [targetUserId, symbol]
                );
                const currentQtyForSymbol = parseInt(openSymbolTrades[0]?.total_qty || 0);
                const newTotalForSymbol = currentQtyForSymbol + qtyNum;

                if (newTotalForSymbol > maxLotScrip) {
                    return res.status(400).json({
                        message: `Max lot size for ${symbol} is ${maxLotScrip}. Current: ${currentQtyForSymbol}, New trade: ${qtyNum}, Total would be: ${newTotalForSymbol}`
                    });
                }
                console.log(`[placeOrder] ✅ Max lot per script (MCX): Symbol=${symbol}, Limit=${maxLotScrip}, Current=${currentQtyForSymbol}, New=${qtyNum}`);
            }
        }

        if (marketType === 'EQUITY') {
            const maxLotScrip = parseInt(clientConfig.equityMaxScrip || 0);
            if (maxLotScrip > 0) {
                const [openSymbolTrades] = await db.execute(
                    'SELECT COALESCE(SUM(qty), 0) as total_qty FROM trades WHERE user_id = ? AND status = "OPEN" AND symbol = ?',
                    [targetUserId, symbol]
                );
                const currentQtyForSymbol = parseInt(openSymbolTrades[0]?.total_qty || 0);
                const newTotalForSymbol = currentQtyForSymbol + qtyNum;

                if (newTotalForSymbol > maxLotScrip) {
                    return res.status(400).json({
                        message: `Max lot size for ${symbol} is ${maxLotScrip}. Current: ${currentQtyForSymbol}, New trade: ${qtyNum}, Total would be: ${newTotalForSymbol}`
                    });
                }
                console.log(`[placeOrder] ✅ Max lot per script (EQUITY): Symbol=${symbol}, Limit=${maxLotScrip}, Current=${currentQtyForSymbol}, New=${qtyNum}`);
            }
        }

        // ─── VALIDATE MAX POSITION SIZE ──────────────────────────────────────
        // Check if total open position would exceed max
        if (marketType === 'MCX') {
            const maxSizeAll = parseInt(clientConfig.mcxMaxSizeAll || 5000);
            const [openTrades] = await db.execute(
                'SELECT COALESCE(SUM(qty), 0) as total_qty FROM trades WHERE user_id = ? AND status = "OPEN" AND market_type = "MCX"',
                [targetUserId]
            );
            const currentOpenQty = parseInt(openTrades[0]?.total_qty || 0);
            const newTotal = currentOpenQty + qtyNum;

            if (newTotal > maxSizeAll) {
                return res.status(400).json({
                    message: `Total MCX position limit is ${maxSizeAll}. Current: ${currentOpenQty}, New trade: ${qtyNum}, Total would be: ${newTotal}`
                });
            }
            console.log(`[placeOrder] ✅ Max position check passed: Current=${currentOpenQty}, Adding=${qtyNum}, Limit=${maxSizeAll}`);
        }

        if (marketType === 'EQUITY') {
            const maxSizeAll = parseInt(clientConfig.equityMaxSizeAll || 2000);
            const [openTrades] = await db.execute(
                'SELECT COALESCE(SUM(qty), 0) as total_qty FROM trades WHERE user_id = ? AND status = "OPEN" AND market_type = "EQUITY"',
                [targetUserId]
            );
            const currentOpenQty = parseInt(openTrades[0]?.total_qty || 0);
            const newTotal = currentOpenQty + qtyNum;

            if (newTotal > maxSizeAll) {
                return res.status(400).json({
                    message: `Total Equity position limit is ${maxSizeAll}. Current: ${currentOpenQty}, New trade: ${qtyNum}, Total would be: ${newTotal}`
                });
            }
        }

        // ─── SEGMENT LIMIT VALIDATION (TIER 2) - Max position VALUE per segment ─
        // Check if total position value in segment would exceed limit
        if (marketType === 'MCX') {
            const segmentLimit = parseInt(clientConfig.mcxSegmentLimit || 0);
            if (segmentLimit > 0) {
                const [segmentValue] = await db.execute(
                    'SELECT COALESCE(SUM(entry_price * qty), 0) as total_value FROM trades WHERE user_id = ? AND status = "OPEN" AND market_type = "MCX"',
                    [targetUserId]
                );
                const currentValue = parseFloat(segmentValue[0]?.total_value || 0);
                const newTradeValue = executionPrice * qtyNum;
                const newTotal = currentValue + newTradeValue;

                if (newTotal > segmentLimit) {
                    return res.status(400).json({
                        message: `MCX segment limit is ₹${segmentLimit.toFixed(2)}. Current value: ₹${currentValue.toFixed(2)}, New trade: ₹${newTradeValue.toFixed(2)}, Total would be: ₹${newTotal.toFixed(2)}`
                    });
                }
                console.log(`[placeOrder] ✅ Segment limit (MCX): Limit=₹${segmentLimit}, Current=₹${currentValue.toFixed(2)}, NewTrade=₹${newTradeValue.toFixed(2)}`);
            }
        }

        if (marketType === 'EQUITY') {
            const segmentLimit = parseInt(clientConfig.equitySegmentLimit || 0);
            if (segmentLimit > 0) {
                const [segmentValue] = await db.execute(
                    'SELECT COALESCE(SUM(entry_price * qty), 0) as total_value FROM trades WHERE user_id = ? AND status = "OPEN" AND market_type = "EQUITY"',
                    [targetUserId]
                );
                const currentValue = parseFloat(segmentValue[0]?.total_value || 0);
                const newTradeValue = executionPrice * qtyNum;
                const newTotal = currentValue + newTradeValue;

                if (newTotal > segmentLimit) {
                    return res.status(400).json({
                        message: `EQUITY segment limit is ₹${segmentLimit.toFixed(2)}. Current value: ₹${currentValue.toFixed(2)}, New trade: ₹${newTradeValue.toFixed(2)}, Total would be: ₹${newTotal.toFixed(2)}`
                    });
                }
            }
        }

        // ─── ALLOW FRESH ENTRY CHECK (TIER 2) ───────────────────────────────
        // If allowFreshEntry is disabled, block new entries when losses exceed threshold
        if (!clientConfig.allowFreshEntry) {
            const [allOpenTrades] = await db.execute(
                'SELECT COALESCE(SUM(pnl), 0) as total_pnl FROM trades WHERE user_id = ? AND status = "OPEN"',
                [targetUserId]
            );
            const totalOpenPnL = parseFloat(allOpenTrades[0]?.total_pnl || 0);
            const userBalance = parseFloat(targetUser.balance || 0);

            if (totalOpenPnL < 0 && userBalance > 0) {
                const lossPercentage = Math.abs(totalOpenPnL) / userBalance * 100;
                // Block entries if loss > 20% (configurable threshold)
                if (lossPercentage > 20) {
                    return res.status(400).json({
                        message: `New entries are blocked. Current loss: ${lossPercentage.toFixed(2)}%. Please close losing positions first.`
                    });
                }
            }
        }

        // 6. Expiry Rules Check
        const [scripRows] = await db.execute('SELECT expiry_date FROM scrip_data WHERE symbol = ?', [symbol]);
        const [expiryRuleRows] = await db.execute('SELECT * FROM expiry_rules WHERE id = 1');
        const expiryRule = expiryRuleRows[0];
        const scrip = scripRows[0];

        if (expiryRule && scrip && scrip.expiry_date) {
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const expiryDate = new Date(scrip.expiry_date);
            expiryDate.setHours(0, 0, 0, 0);
            const daysLeft = Math.ceil((expiryDate - today) / (1000 * 60 * 60 * 24));

            // Days before expiry check
            const stopDays = parseInt(expiryRule.days_before_expiry) || 0;
            if (stopDays > 0 && daysLeft <= stopDays && expiryRule.allow_expiring_scrip === 'No') {
                return res.status(400).json({
                    message: `${symbol} expires in ${daysLeft} day(s). New orders are not allowed within ${stopDays} days of expiry.`
                });
            }

            // Away points check for limit orders (TIER 2 - Enhanced with segment-specific limits)
            if (order_type !== 'MARKET' && price) {
                const currentPriceNow = mockEngine.getPrice(symbol);
                const diff = Math.abs(parseFloat(price) - currentPriceNow);

                // Check expiry rule away points first (if configured)
                let maxAllowedAway = 0;
                if (expiryRule) {
                    const awayPoints = expiryRule.away_points ? JSON.parse(expiryRule.away_points) : {};
                    maxAllowedAway = parseFloat(awayPoints[symbol] || 0);
                }

                // Also check segment-specific away points from client config
                let segmentOrdersAway = 0;
                if (marketType === 'MCX') {
                    segmentOrdersAway = parseInt(clientConfig.mcxOrdersAway || 0);
                } else if (marketType === 'EQUITY') {
                    segmentOrdersAway = parseInt(clientConfig.equityOrdersAway || 0);
                } else if (marketType === 'OPTIONS') {
                    segmentOrdersAway = parseInt(clientConfig.optionsOrdersAway || 0);
                } else if (marketType === 'COMEX') {
                    segmentOrdersAway = parseInt(clientConfig.comexConfig?.ordersAway || 0);
                } else if (marketType === 'FOREX') {
                    segmentOrdersAway = parseInt(clientConfig.forexConfig?.ordersAway || 0);
                } else if (marketType === 'CRYPTO') {
                    segmentOrdersAway = parseInt(clientConfig.cryptoConfig?.ordersAway || 0);
                }

                // Use the stricter limit (whichever is lower)
                const effectiveLimit = Math.max(maxAllowedAway, segmentOrdersAway);
                if (effectiveLimit > 0 && diff > effectiveLimit) {
                    return res.status(400).json({
                        message: `Limit order price too far from market. Max ${effectiveLimit} points away. Current: ${currentPriceNow}, Your price: ${price}`
                    });
                }
            }
        }

        // ─── EXPOSURE-BASED MARGIN CALCULATION (PHASE 2) ──────────────────────
        let marginRequired = 0;

        // MCX Intraday Exposure (new trades are always intraday when placed)
        if (marketType === 'MCX') {
            // For new trades being placed, always use intraday exposure
            // (holding exposure only applies when closing existing overnight positions)
            const exposureValue = parseInt(clientConfig.mcxIntradayMargin || 500);
            console.log(`[placeOrder] New MCX trade - Using intraday exposure: ${exposureValue}`);

            // Exposure calculation: turnover / exposure = margin
            const turnover = executionPrice * qtyNum;
            const exposureType = clientConfig.exposureMcxType || 'Per Turnover Basis';

            if (exposureType === 'Per Turnover Basis') {
                // Margin = (Price × Qty) / Exposure
                marginRequired = turnover / exposureValue;
            } else {
                // Fixed exposure
                marginRequired = exposureValue * qtyNum;
            }

            console.log(`[placeOrder] ✅ MCX Exposure: Turnover=${turnover}, Exposure=${exposureValue}, MarginRequired=${marginRequired.toFixed(2)}`);
        }

        // EQUITY Intraday/Holding Exposure
        if (marketType === 'EQUITY') {
            const exposureValue = parseInt(clientConfig.equityIntradayMargin || 500);
            const turnover = executionPrice * qtyNum;

            marginRequired = turnover / exposureValue;
            console.log(`[placeOrder] ✅ EQUITY Exposure: Turnover=${turnover}, Exposure=${exposureValue}, MarginRequired=${marginRequired.toFixed(2)}`);
        }

        // Fallback if no exposure calculated
        if (marginRequired <= 0) {
            marginRequired = (executionPrice * qtyNum) * 0.1; // 10% default
        }

        // 8. Balance Check with calculated margin
        if (targetUser.balance < marginRequired) {
            const avail = parseFloat(targetUser.balance || 0).toFixed(2);
            return res.status(400).json({
                message: `Insufficient balance. Required margin: ₹${marginRequired.toFixed(2)}, Available: ₹${avail}`,
                required: marginRequired.toFixed(2),
                available: avail
            });
        }

        // ─── BROKER SEGMENT VALIDATION ─────────────────────────────────────
        // Get client's broker info and validate against broker's CURRENT segment config
        const [clientSettings] = await db.execute(
            'SELECT broker_id FROM client_settings WHERE user_id = ?',
            [targetUserId]
        );

        if (clientSettings.length > 0 && clientSettings[0].broker_id) {
            const brokerIdForClient = clientSettings[0].broker_id;
            try {
                // Fetch CURRENT broker config (not cached client config)
                const [brokerSharesRows] = await db.execute(
                    'SELECT segments_json FROM broker_shares WHERE user_id = ?',
                    [brokerIdForClient]
                );

                if (brokerSharesRows.length > 0 && brokerSharesRows[0].segments_json) {
                    const brokerSegments = JSON.parse(brokerSharesRows[0].segments_json);
                    const brokerSegmentConfig = brokerSegments.segmentConfig || {};

                    // Determine segment key based on market type
                    let segmentKey = null;
                    if (marketType === 'MCX') {
                        segmentKey = 'mcx_all_future';
                    } else if (marketType === 'COMEX') {
                        segmentKey = 'comex_commodity_future';
                    } else if (marketType === 'FOREX') {
                        segmentKey = 'forex';
                    } else if (marketType === 'CRYPTO') {
                        segmentKey = 'crypto';
                    } else if (marketType === 'EQUITY') {
                        segmentKey = 'equity';
                    }

                    // Check if segment is enabled for this broker (LIVE check)
                    if (segmentKey && brokerSegmentConfig[segmentKey]) {
                        const segConfig = brokerSegmentConfig[segmentKey];
                        if (!segConfig.enabled) {
                            return res.status(403).json({
                                message: `Trading disabled for ${marketType} segment by your broker`
                            });
                        }
                        console.log(`[placeOrder] ✅ ${marketType} segment enabled for broker ${brokerIdForClient}`);
                    }
                }
            } catch (e) {
                console.error('[placeOrder] Error validating broker segment config:', e);
                // Continue - validation error shouldn't block the trade
            }
        }

        // ─── SHORT SELLING VALIDATION (TIER 2) ────────────────────────────────
        // Check if short selling (SELL orders) is allowed for this segment
        if (type.toUpperCase() === 'SELL') {
            let isShortSellingAllowed = true;
            let deniedReason = '';

            if (marketType === 'OPTIONS') {
                // For options, check specific short selling flags based on sub-segment
                if (symbol.includes('NIFTY') || symbol.includes('BANKNIFTY')) {
                    isShortSellingAllowed = clientConfig.optionsIndexShortSelling === 'Yes';
                    if (!isShortSellingAllowed) deniedReason = 'Options Index';
                } else if (symbol.includes('MCX') || symbol.includes('GOLD') || symbol.includes('SILVER')) {
                    isShortSellingAllowed = clientConfig.optionsMcxShortSelling === 'Yes';
                    if (!isShortSellingAllowed) deniedReason = 'Options MCX';
                } else {
                    isShortSellingAllowed = clientConfig.optionsEquityShortSelling === 'Yes';
                    if (!isShortSellingAllowed) deniedReason = 'Options Equity';
                }
            }

            if (!isShortSellingAllowed) {
                return res.status(400).json({
                    message: `Short selling is not allowed for ${deniedReason || marketType} segment in your account`
                });
            }
        }

        // ─── TIER 3: OPTIONS-SPECIFIC VALIDATIONS ──────────────────────────────
        if (marketType === 'OPTIONS') {
            // Options Min Bid Price check
            const optionsMinBidPrice = parseFloat(clientConfig.optionsMinBidPrice || 1);
            if (price && parseFloat(price) < optionsMinBidPrice) {
                return res.status(400).json({
                    message: `Minimum bid price for options is ₹${optionsMinBidPrice}. Your price: ₹${price}`
                });
            }

            // Determine options sub-segment and apply lot limits
            let maxLotConfig = 0;
            let maxLotScripConfig = 0;
            let marginIntradayConfig = 0;
            let marginHoldingConfig = 0;

            if (symbol.includes('NIFTY') || symbol.includes('BANKNIFTY')) {
                // Index options
                maxLotConfig = parseInt(clientConfig.optionsIndexMaxLot || 20);
                maxLotScripConfig = parseInt(clientConfig.optionsIndexMaxScrip || 200);
                marginIntradayConfig = parseInt(clientConfig.optionsIndexIntraday || 5);
                marginHoldingConfig = parseInt(clientConfig.optionsIndexHolding || 2);
            } else if (symbol.includes('MCX')) {
                // MCX options
                maxLotConfig = parseInt(clientConfig.optionsMcxMaxLot || 50);
                maxLotScripConfig = parseInt(clientConfig.optionsMcxMaxScrip || 200);
                marginIntradayConfig = parseInt(clientConfig.optionsMcxIntraday || 5);
                marginHoldingConfig = parseInt(clientConfig.optionsMcxHolding || 2);
            } else {
                // Equity options
                maxLotConfig = parseInt(clientConfig.optionsEquityMaxLot || 50);
                maxLotScripConfig = parseInt(clientConfig.optionsEquityMaxScrip || 200);
                marginIntradayConfig = parseInt(clientConfig.optionsEquityIntraday || 5);
                marginHoldingConfig = parseInt(clientConfig.optionsEquityHolding || 2);
            }

            // Check lot size limits for options
            if (qtyNum < parseInt(clientConfig.optionsEquityMinLot || 0)) {
                return res.status(400).json({
                    message: `Minimum lot size for OPTIONS is ${clientConfig.optionsEquityMinLot || 1}. You entered ${qtyNum}`
                });
            }
            if (qtyNum > maxLotConfig) {
                return res.status(400).json({
                    message: `Maximum lot size for OPTIONS is ${maxLotConfig}. You entered ${qtyNum}`
                });
            }

            // Check max lots per script for options
            const [openOptionsForSymbol] = await db.execute(
                'SELECT COALESCE(SUM(qty), 0) as total_qty FROM trades WHERE user_id = ? AND status = "OPEN" AND symbol = ? AND market_type = "OPTIONS"',
                [targetUserId, symbol]
            );
            const currentOptionsQtyForSymbol = parseInt(openOptionsForSymbol[0]?.total_qty || 0);
            const newOptionsTotalForSymbol = currentOptionsQtyForSymbol + qtyNum;

            if (newOptionsTotalForSymbol > maxLotScripConfig) {
                return res.status(400).json({
                    message: `Max lot size for ${symbol} is ${maxLotScripConfig}. Current: ${currentOptionsQtyForSymbol}, New: ${qtyNum}, Total would be: ${newOptionsTotalForSymbol}`
                });
            }

            // Check max options position size
            let maxOptionsSizeAll = 200;
            if (symbol.includes('NIFTY') || symbol.includes('BANKNIFTY')) {
                maxOptionsSizeAll = parseInt(clientConfig.optionsMaxIndexSizeAll || 200);
            } else if (symbol.includes('MCX')) {
                maxOptionsSizeAll = parseInt(clientConfig.optionsMaxMcxSizeAll || 200);
            } else {
                maxOptionsSizeAll = parseInt(clientConfig.optionsMaxEquitySizeAll || 200);
            }

            const [openAllOptions] = await db.execute(
                'SELECT COALESCE(SUM(qty), 0) as total_qty FROM trades WHERE user_id = ? AND status = "OPEN" AND market_type = "OPTIONS"',
                [targetUserId]
            );
            const currentAllOptionsQty = parseInt(openAllOptions[0]?.total_qty || 0);
            const newAllOptionsTotal = currentAllOptionsQty + qtyNum;

            if (newAllOptionsTotal > maxOptionsSizeAll) {
                return res.status(400).json({
                    message: `Max OPTIONS position limit is ${maxOptionsSizeAll}. Current: ${currentAllOptionsQty}, New: ${qtyNum}, Total would be: ${newAllOptionsTotal}`
                });
            }

            // Log options validations passed
            console.log(`[placeOrder] ✅ OPTIONS validations: Lot=${qtyNum}, MaxLot=${maxLotConfig}, MaxPerScript=${maxLotScripConfig}, MaxAll=${maxOptionsSizeAll}`);
        }

        // ─── TIER 3: KYC VERIFICATION CHECK ────────────────────────────────────
        // Check if account has valid KYC status for trading
        try {
            const [kycStatus] = await db.execute(
                'SELECT kyc_status FROM users WHERE id = ?',
                [targetUserId]
            );
            if (kycStatus.length > 0) {
                const userKycStatus = kycStatus[0].kyc_status || 'Pending';
                if (userKycStatus === 'Rejected' || userKycStatus === 'Pending') {
                    return res.status(403).json({
                        message: `Your KYC status is ${userKycStatus}. Please complete KYC verification to trade.`
                    });
                }
            }
        } catch (e) {
            console.error('[placeOrder] KYC check error:', e);
            // Continue if KYC column doesn't exist yet
        }

        // ─── TIER 3: INTERNATIONAL SEGMENT VALIDATIONS ──────────────────────────
        // Apply segment-specific lot size and position validations
        if (marketType === 'COMEX' && clientConfig.comexTrading) {
            const comexConfig = clientConfig.comexConfig || {};
            const minLot = parseInt(comexConfig.minLot || 1);
            const maxLot = parseInt(comexConfig.maxLot || 100);

            if (qtyNum < minLot) {
                return res.status(400).json({
                    message: `Minimum lot size for COMEX is ${minLot}. You entered ${qtyNum}`
                });
            }
            if (qtyNum > maxLot) {
                return res.status(400).json({
                    message: `Maximum lot size for COMEX is ${maxLot}. You entered ${qtyNum}`
                });
            }

            // Check max per script
            const comexMaxLotScrip = parseInt(comexConfig.maxLotScrip || 0);
            if (comexMaxLotScrip > 0) {
                const [openComexForSymbol] = await db.execute(
                    'SELECT COALESCE(SUM(qty), 0) as total_qty FROM trades WHERE user_id = ? AND status = "OPEN" AND symbol = ? AND market_type = "COMEX"',
                    [targetUserId, symbol]
                );
                const currentComexQty = parseInt(openComexForSymbol[0]?.total_qty || 0);
                if (currentComexQty + qtyNum > comexMaxLotScrip) {
                    return res.status(400).json({
                        message: `Max lot size for ${symbol} (COMEX) is ${comexMaxLotScrip}`
                    });
                }
            }

            // Check max position size
            const comexMaxSizeAll = parseInt(comexConfig.maxSizeAll || 0);
            if (comexMaxSizeAll > 0) {
                const [openComexAll] = await db.execute(
                    'SELECT COALESCE(SUM(qty), 0) as total_qty FROM trades WHERE user_id = ? AND status = "OPEN" AND market_type = "COMEX"',
                    [targetUserId]
                );
                const currentComexAll = parseInt(openComexAll[0]?.total_qty || 0);
                if (currentComexAll + qtyNum > comexMaxSizeAll) {
                    return res.status(400).json({
                        message: `Max COMEX position limit is ${comexMaxSizeAll}. Current: ${currentComexAll}, New: ${qtyNum}`
                    });
                }
            }
            console.log(`[placeOrder] ✅ COMEX validations passed`);
        }

        if (marketType === 'FOREX' && clientConfig.forexTrading) {
            const forexConfig = clientConfig.forexConfig || {};
            const minLot = parseInt(forexConfig.minLot || 1);
            const maxLot = parseInt(forexConfig.maxLot || 100);

            if (qtyNum < minLot || qtyNum > maxLot) {
                return res.status(400).json({
                    message: `FOREX lot size must be between ${minLot} and ${maxLot}. You entered ${qtyNum}`
                });
            }

            // Check max position size
            const forexMaxSizeAll = parseInt(forexConfig.maxSizeAll || 0);
            if (forexMaxSizeAll > 0) {
                const [openForexAll] = await db.execute(
                    'SELECT COALESCE(SUM(qty), 0) as total_qty FROM trades WHERE user_id = ? AND status = "OPEN" AND market_type = "FOREX"',
                    [targetUserId]
                );
                const currentForexAll = parseInt(openForexAll[0]?.total_qty || 0);
                if (currentForexAll + qtyNum > forexMaxSizeAll) {
                    return res.status(400).json({
                        message: `Max FOREX position limit is ${forexMaxSizeAll}`
                    });
                }
            }
            console.log(`[placeOrder] ✅ FOREX validations passed`);
        }

        if (marketType === 'CRYPTO' && clientConfig.cryptoTrading) {
            const cryptoConfig = clientConfig.cryptoConfig || {};
            const minLot = parseInt(cryptoConfig.minLot || 1);
            const maxLot = parseInt(cryptoConfig.maxLot || 100);

            if (qtyNum < minLot || qtyNum > maxLot) {
                return res.status(400).json({
                    message: `CRYPTO lot size must be between ${minLot} and ${maxLot}. You entered ${qtyNum}`
                });
            }

            // Check max position size
            const cryptoMaxSizeAll = parseInt(cryptoConfig.maxSizeAll || 0);
            if (cryptoMaxSizeAll > 0) {
                const [openCryptoAll] = await db.execute(
                    'SELECT COALESCE(SUM(qty), 0) as total_qty FROM trades WHERE user_id = ? AND status = "OPEN" AND market_type = "CRYPTO"',
                    [targetUserId]
                );
                const currentCryptoAll = parseInt(openCryptoAll[0]?.total_qty || 0);
                if (currentCryptoAll + qtyNum > cryptoMaxSizeAll) {
                    return res.status(400).json({
                        message: `Max CRYPTO position limit is ${cryptoMaxSizeAll}`
                    });
                }
            }
            console.log(`[placeOrder] ✅ CRYPTO validations passed`);
        }

        // ─── TIER 3: AUTO SQUARE-OFF AT EXPIRY CHECK ──────────────────────────
        // Check if order is being placed too close to expiry
        if (clientConfig.autoSquareOff === 'Yes') {
            try {
                const [expiryData] = await db.execute(
                    'SELECT expiry_date FROM scrip_data WHERE symbol = ?',
                    [symbol]
                );
                if (expiryData.length > 0 && expiryData[0].expiry_date) {
                    const expiryDate = new Date(expiryData[0].expiry_date);
                    const now = new Date();
                    const timeUntilExpiry = expiryDate - now;
                    const hoursUntilExpiry = timeUntilExpiry / (1000 * 60 * 60);

                    // Parse square off time (e.g., "11:30")
                    const squareOffTime = clientConfig.expirySquareOffTime || '11:30';
                    const [squareOffHour, squareOffMin] = squareOffTime.split(':').map(Number);

                    // Log auto square-off info
                    console.log(`[placeOrder] ℹ️ Auto square-off check: ExpiryIn=${hoursUntilExpiry.toFixed(1)}h, SquareOffAt=${squareOffTime}`);
                }
            } catch (e) {
                console.error('[placeOrder] Auto square-off check error:', e);
            }
        }

        console.log('Executing with:', { targetUserId, symbol, type, executionPrice, marginRequired, marketType });

        // 8. Insert Trade
        const [result] = await db.execute(
            `INSERT INTO trades
                (user_id, symbol, type, order_type, qty, entry_price, exit_price, margin_used, is_pending, market_type, status, trade_ip, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                targetUserId,
                sym,
                type.toUpperCase(),
                order_type,
                qtyNum,
                executionPrice,
                exit_price ? parseFloat(exit_price) : null,
                marginRequired,
                is_pending ? 1 : 0,
                marketType,
                'OPEN',
                tradeIp,
                requesterId
            ]
        );

        // 8. Deduct Margin from Balance
        await db.execute(
            'UPDATE users SET balance = balance - ? WHERE id = ?',
            [marginRequired, targetUserId]
        );

        console.log('✅ Trade Inserted:', result.insertId);
        res.status(201).json({
            message: 'Order placed successfully',
            tradeId: result.insertId,
            executionPrice,
            marginUsed: marginRequired
        });

        // Log the trade placement
        await logAction(requesterId, 'PLACE_ORDER', 'trades', `Placed ${type.toUpperCase()} order for ${sym} (Qty: ${qtyNum}, Price: ${executionPrice}) for user #${targetUserId}`);


    } catch (err) {
        console.error('❌ Trade Placement Error:', err);
        res.status(500).json({ message: 'Internal Server Error', error: err.message });
    }
};

/**
 * Get Trades by Status (Active, Closed, Deleted)
 */
const getTrades = async (req, res) => {
    const { status, user_id } = req.query; // OPEN, CLOSED, DELETED, CANCELLED
    try {
        let query = 'SELECT t.*, u.username FROM trades t JOIN users u ON t.user_id = u.id WHERE 1=1';
        const params = [];

        if (status) {
            query += ' AND t.status = ?';
            params.push(status);
        }

        if (req.query.is_pending !== undefined) {
            const isPending = req.query.is_pending === 'true' || req.query.is_pending === '1' ? 1 : 0;
            query += ' AND t.is_pending = ?';
            params.push(isPending);
            // Pending orders list should only show active (OPEN) ones, not cancelled
            if (isPending === 1 && !status) {
                query += " AND t.status = 'OPEN'";
            }
        }

        // Filter by specific user_id (for client detail views)
        if (user_id) {
            query += ' AND t.user_id = ?';
            params.push(user_id);
            
            // Even if user_id is provided, non-traders should only see trades they created for that user
            if (req.user.role !== 'TRADER') {
                query += ' AND t.created_by = ?';
                params.push(req.user.id);
            }
        } else {
            // Role-based visibility logic: "Jisme jo trade banai usko vahi dikhe"
            if (req.user.role === 'TRADER') {
                // Traders see their own trades
                query += ' AND t.user_id = ?';
                params.push(req.user.id);
            } else {
                // Admins, Brokers, Superadmins see only trades THEY created
                query += ' AND t.created_by = ?';
                params.push(req.user.id);
            }
        }

        // Filter by username
        if (req.query.username) {
            query += ' AND u.username LIKE ?';
            params.push(`%${req.query.username}%`);
        }

        // Filter by scrip (symbol)
        if (req.query.scrip) {
            query += ' AND t.symbol LIKE ?';
            params.push(`%${req.query.scrip}%`);
        }

        // Filter by date range
        if (req.query.fromDate) {
            query += ' AND DATE(t.entry_time) >= ?';
            params.push(req.query.fromDate);
        }
        if (req.query.toDate) {
            query += ' AND DATE(t.entry_time) <= ?';
            params.push(req.query.toDate);
        }

        query += ' ORDER BY t.entry_time DESC';
        console.log('[getTrades] Query:', query);
        console.log('[getTrades] Params:', params);
        const [rows] = await db.execute(query, params);
        console.log('[getTrades] Results:', rows.length, 'trades found for user:', req.user.id);
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
};

/**
 * Get Single Trade by ID
 */
const getTradeById = async (req, res) => {
    try {
        const [rows] = await db.execute(
            `SELECT t.*, u.username, u.full_name
             FROM trades t
             JOIN users u ON t.user_id = u.id
             WHERE t.id = ?`,
            [req.params.id]
        );

        if (rows.length === 0) {
            return res.status(404).json({ message: 'Trade not found' });
        }

        const trade = rows[0];
        const { id: requesterId } = req.user;
        
        // Access check: "Jisme jo trade banai usko vahi dikhe"
        // Target user (Trader) can see their own trades OR Creator can see trades they placed
        const isTargetUser = trade.user_id === requesterId;
        const isCreator = trade.created_by === requesterId;

        if (!isTargetUser && !isCreator) {
            return res.status(403).json({ message: 'Not authorized to view this trade' });
        }

        res.json(trade);
    } catch (err) {
        console.error('Get Trade by ID Error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
};

const getGroupTrades = async (req, res) => {
    try {
        const { id, role } = req.user;
        const { scrip, segment, fromDate, toDate } = req.query;

        let query = `
            SELECT
                t.symbol,
                t.type,
                t.market_type,
                SUM(t.qty) as total_qty,
                AVG(t.entry_price) as avg_price,
                COUNT(*) as trade_count
            FROM trades t
            JOIN users u ON t.user_id = u.id
            WHERE t.status = 'OPEN'
        `;
        const params = [];

        // Hierarchy Isolation: "Jisme jo trade banai usko vahi dikhe"
        if (role === 'TRADER') {
            query += ` AND t.user_id = ?`;
            params.push(id);
        } else {
            // For others, only show groups of trades THEY created
            query += ` AND t.created_by = ?`;
            params.push(id);
        }
        // Note: Joining users table is kept if needed for future filters, 
        // though currently we filter by trade.user_id/created_by directly where possible.

        // Filter by scrip (symbol)
        if (scrip) {
            query += ` AND t.symbol LIKE ?`;
            params.push(`%${scrip}%`);
        }

        // Filter by segment (market type)
        if (segment && segment !== 'All') {
            query += ` AND t.market_type = ?`;
            params.push(segment);
        }

        // Filter by date range
        if (fromDate) {
            query += ` AND DATE(t.entry_time) >= ?`;
            params.push(fromDate);
        }
        if (toDate) {
            query += ` AND DATE(t.entry_time) <= ?`;
            params.push(toDate);
        }

        query += ` GROUP BY t.symbol, t.type, t.market_type ORDER BY t.symbol ASC`;

        const [rows] = await db.execute(query, params);
        res.json(rows);
    } catch (err) {

        console.error(err);
        res.status(500).send('Server Error');
    }
};

/**
 * Close/Square-off Trade
 * - Pending orders (is_pending=1): cancelled immediately, margin refunded, no PnL
 * - Open orders: closed at exitPrice or current market price
 */
const closeTrade = async (req, res) => {
    const { exitPrice } = req.body;
    try {
        const [trades] = await db.execute('SELECT * FROM trades WHERE id = ?', [req.params.id]);
        if (trades.length === 0) return res.status(404).json({ message: 'Trade not found' });

        const trade = trades[0];

        if (trade.status !== 'OPEN') {
            return res.status(400).json({ message: 'Trade is already closed or inactive' });
        }

        // ─── MIN TIME TO PROFIT VALIDATION (PHASE 1) ─────────────────────────
        // Get client config
        const [clientSettings] = await db.execute(
            'SELECT config_json FROM client_settings WHERE user_id = ?',
            [trade.user_id]
        );
        const clientConfig = clientSettings.length > 0 ? JSON.parse(clientSettings[0].config_json || '{}') : {};

        // Get min time to profit for this segment
        let minTimeSeconds = 0;
        if (trade.market_type === 'MCX') {
            minTimeSeconds = parseInt(clientConfig.mcxMinTimeToBookProfit || 0);
        } else if (trade.market_type === 'EQUITY') {
            minTimeSeconds = parseInt(clientConfig.equityMinTimeToBookProfit || 0);
        }

        // Check if trade held long enough
        if (minTimeSeconds > 0) {
            const entryTime = new Date(trade.entry_time);
            const now = new Date();
            const secondsHeld = Math.floor((now - entryTime) / 1000);

            // Only check if trying to close in profit
            const currentPrice = exitPrice || mockEngine.getPrice(trade.symbol);
            const pnl = trade.type === 'BUY'
                ? (currentPrice - trade.entry_price) * trade.qty
                : (trade.entry_price - currentPrice) * trade.qty;

            if (pnl > 0 && secondsHeld < minTimeSeconds) {
                const remainingSeconds = minTimeSeconds - secondsHeld;
                return res.status(400).json({
                    message: `Minimum profit booking time is ${minTimeSeconds} seconds. You can close in ${remainingSeconds} seconds.`,
                    secondsHeld,
                    minTimeSeconds,
                    remainingSeconds
                });
            }
            if (pnl > 0) {
                console.log(`[closeTrade] ✅ Min time check passed: Held=${secondsHeld}s, Min=${minTimeSeconds}s`);
            }
        }

        // ─── SCALPING STOP LOSS VALIDATION (TIER 2) ────────────────────────
        // Block closing in loss if scalping stop loss is enabled and held < min time
        let scalpingStopLossEnabled = false;
        if (trade.market_type === 'MCX') {
            scalpingStopLossEnabled = clientConfig.mcxScalpingStopLoss === 'Enabled';
        } else if (trade.market_type === 'EQUITY') {
            scalpingStopLossEnabled = clientConfig.equityScalpingStopLoss === 'Enabled';
        } else if (trade.market_type === 'OPTIONS') {
            scalpingStopLossEnabled = clientConfig.optionsScalpingStopLoss === 'Enabled';
        } else if (trade.market_type === 'COMEX') {
            scalpingStopLossEnabled = clientConfig.comexConfig?.scalpingStopLoss === 'Enabled';
        } else if (trade.market_type === 'FOREX') {
            scalpingStopLossEnabled = clientConfig.forexConfig?.scalpingStopLoss === 'Enabled';
        } else if (trade.market_type === 'CRYPTO') {
            scalpingStopLossEnabled = clientConfig.cryptoConfig?.scalpingStopLoss === 'Enabled';
        }

        if (scalpingStopLossEnabled) {
            const currentPrice = exitPrice || mockEngine.getPrice(trade.symbol);
            const pnlAtClose = trade.type === 'BUY'
                ? (currentPrice - trade.entry_price) * trade.qty
                : (trade.entry_price - currentPrice) * trade.qty;

            // Only check if trying to close in loss
            if (pnlAtClose < 0) {
                const entryTime = new Date(trade.entry_time);
                const now = new Date();
                const secondsHeld = Math.floor((now - entryTime) / 1000);
                // Get min time config
                let minTimeSeconds = 0;
                if (trade.market_type === 'MCX') {
                    minTimeSeconds = parseInt(clientConfig.mcxMinTimeToBookProfit || 0);
                } else if (trade.market_type === 'EQUITY') {
                    minTimeSeconds = parseInt(clientConfig.equityMinTimeToBookProfit || 0);
                } else if (trade.market_type === 'OPTIONS') {
                    minTimeSeconds = parseInt(clientConfig.optionsMinTimeToBookProfit || 0);
                }

                if (minTimeSeconds > 0 && secondsHeld < minTimeSeconds) {
                    const remainingSeconds = minTimeSeconds - secondsHeld;
                    return res.status(400).json({
                        message: `Scalping stop loss is enabled. Cannot close in loss before ${minTimeSeconds}s. Held: ${secondsHeld}s, Remaining: ${remainingSeconds}s`,
                        secondsHeld,
                        minRequired: minTimeSeconds,
                        remainingSeconds,
                        pnl: pnlAtClose
                    });
                }
            }
        }

        const marginToRelease = parseFloat(trade.margin_used || 0);

        // Pending orders: cancel with no PnL, just refund margin
        if (trade.is_pending == 1) {
            await db.execute(
                'UPDATE trades SET status = "CANCELLED", exit_price = entry_price, exit_time = NOW(), pnl = 0 WHERE id = ?',
                [req.params.id]
            );
            await db.execute(
                'UPDATE users SET balance = balance + ? WHERE id = ?',
                [marginToRelease, trade.user_id]
            );
            await logAction(req.user.id || trade.user_id, 'CANCEL_TRADE', 'trades', `Cancelled pending order #${trade.id}. Margin refunded: ${marginToRelease}`);
            return res.json({ message: 'Pending order cancelled', pnl: 0, marginReleased: marginToRelease, newBalanceChange: marginToRelease });
        }

        // ─── AUTO CLOSE AT LOSS % (PHASE 2) ──────────────────────────────────
        // Check if account losses exceed threshold and auto-close is enabled
        const autoClosePct = parseInt(clientConfig.autoClosePercentage || 90);

        // Get current user balance
        const [userRows] = await db.execute('SELECT balance FROM users WHERE id = ?', [trade.user_id]);
        const userBalance = parseFloat(userRows[0]?.balance || 0);

        // Get all OPEN trades for this user
        const [allOpenTrades] = await db.execute(
            'SELECT id, pnl FROM trades WHERE user_id = ? AND status = "OPEN"',
            [trade.user_id]
        );

        let totalOpenPnL = 0;
        for (const openTrade of allOpenTrades) {
            totalOpenPnL += parseFloat(openTrade.pnl || 0);
        }

        const lossPercentage = Math.abs(totalOpenPnL) / userBalance * 100;

        if (totalOpenPnL < 0 && lossPercentage >= autoClosePct) {
            console.log(`[closeTrade] ⚠️ AUTO CLOSE TRIGGERED: Loss=${Math.abs(totalOpenPnL).toFixed(2)}, LossPct=${lossPercentage.toFixed(2)}%, Threshold=${autoClosePct}%`);
            // In production, this would trigger automatic closing of all trades
            // For now, we log it and continue with manual close
        }

        const currentPrice = mockEngine.getPrice(trade.symbol);
        const finalExitPrice = exitPrice || trade.exit_price || currentPrice;

        const pnl = trade.type === 'BUY'
            ? (finalExitPrice - trade.entry_price) * trade.qty
            : (trade.entry_price - finalExitPrice) * trade.qty;

        // ─── CALCULATE BROKERAGE FROM BROKER CONFIG (TIER 3) ─────────────────────────
        let brokerage = 0;
        let swap = 0;
        let brokerSwapRate = 5;  // Default swap rate
        try {
            const [clientSettings] = await db.execute(
                'SELECT broker_id, config_json FROM client_settings WHERE user_id = ?',
                [trade.user_id]
            );

            if (clientSettings.length > 0 && clientSettings[0].broker_id) {
                const brokerIdForClient = clientSettings[0].broker_id;
                const clientConfig = JSON.parse(clientSettings[0].config_json || '{}');

                // ─── SEGMENT-SPECIFIC BROKERAGE CALCULATION (TIER 3) ──────────
                if (trade.market_type === 'MCX') {
                    const brokerMcxBrokerage = clientConfig.brokerMcxBrokerage || {};
                    const symbolBrokerage = brokerMcxBrokerage[trade.symbol];
                    if (symbolBrokerage !== undefined) {
                        brokerage = trade.qty * parseFloat(symbolBrokerage);
                        console.log(`[closeTrade] ✅ MCX Brokerage: Symbol=${trade.symbol}, PerLot=${symbolBrokerage}, Total=${brokerage}`);
                    }
                } else if (trade.market_type === 'EQUITY') {
                    const brokerEquityBrokerage = clientConfig.brokerEquityBrokerage || {};
                    const symbolBrokerage = brokerEquityBrokerage[trade.symbol];
                    if (symbolBrokerage !== undefined) {
                        brokerage = trade.qty * parseFloat(symbolBrokerage);
                        console.log(`[closeTrade] ✅ EQUITY Brokerage: Symbol=${trade.symbol}, PerLot=${symbolBrokerage}, Total=${brokerage}`);
                    }
                } else if (trade.market_type === 'OPTIONS') {
                    // Options brokerage can be per-lot based
                    let brokeragePerLot = 0;
                    const brokerOptionsEquityBrokerage = clientConfig.brokerOptionsEquityBrokerage || 0;
                    const brokerOptionsIndexBrokerage = clientConfig.brokerOptionsIndexBrokerage || 0;
                    const brokerOptionsMcxBrokerage = clientConfig.brokerOptionsMcxBrokerage || 0;

                    if (trade.symbol.includes('NIFTY') || trade.symbol.includes('BANKNIFTY')) {
                        brokeragePerLot = parseFloat(brokerOptionsIndexBrokerage || 0);
                    } else if (trade.symbol.includes('MCX')) {
                        brokeragePerLot = parseFloat(brokerOptionsMcxBrokerage || 0);
                    } else {
                        brokeragePerLot = parseFloat(brokerOptionsEquityBrokerage || 0);
                    }

                    if (brokeragePerLot > 0) {
                        brokerage = trade.qty * brokeragePerLot;
                        console.log(`[closeTrade] ✅ OPTIONS Brokerage: Symbol=${trade.symbol}, PerLot=${brokeragePerLot}, Total=${brokerage}`);
                    }
                } else if (trade.market_type === 'COMEX') {
                    const comexBrokeragePerLot = parseFloat(clientConfig.brokerComexBrokerage || 0);
                    if (comexBrokeragePerLot > 0) {
                        brokerage = trade.qty * comexBrokeragePerLot;
                    }
                } else if (trade.market_type === 'FOREX') {
                    const forexBrokeragePerLot = parseFloat(clientConfig.brokerForexBrokerage || 0);
                    if (forexBrokeragePerLot > 0) {
                        brokerage = trade.qty * forexBrokeragePerLot;
                    }
                } else if (trade.market_type === 'CRYPTO') {
                    const cryptoBrokeragePerLot = parseFloat(clientConfig.brokerCryptoBrokerage || 0);
                    if (cryptoBrokeragePerLot > 0) {
                        brokerage = trade.qty * cryptoBrokeragePerLot;
                    }
                }

                // ─── CALCULATE SWAP CHARGES ────────────────────────────────
                // Fetch broker's swap rate
                const [brokerShares] = await db.execute(
                    'SELECT swap_rate FROM broker_shares WHERE user_id = ?',
                    [brokerIdForClient]
                );
                if (brokerShares.length > 0) {
                    brokerSwapRate = parseFloat(brokerShares[0].swap_rate || 5);
                }

                // Calculate days held (swap charged for overnight holdings)
                const entryTime = new Date(trade.entry_time);
                const exitTime = new Date();
                const daysHeld = Math.ceil((exitTime - entryTime) / (1000 * 60 * 60 * 24));

                // Only charge swap if position held more than 1 day (MCX/EQUITY only)
                if ((trade.market_type === 'MCX' || trade.market_type === 'EQUITY') && daysHeld > 1) {
                    swap = trade.qty * brokerSwapRate * (daysHeld - 1);  // -1 because first day is intraday
                    console.log(`[closeTrade] ✅ Swap: Qty=${trade.qty}, Rate=${brokerSwapRate}/lot, Days=${daysHeld - 1}, Total=${swap}`);
                }
            }
        } catch (e) {
            console.error('[closeTrade] Error calculating brokerage/swap from broker config:', e);
        }

        // ─── LOSS NOTIFICATION CHECK (PHASE 2) ───────────────────────────────
        const notifyPct = parseInt(clientConfig.notifyPercentage || 70);

        // Recalculate total PnL after this trade close
        const [updatedOpenTrades] = await db.execute(
            'SELECT COALESCE(SUM(pnl), 0) as total_pnl FROM trades WHERE user_id = ? AND status = "OPEN" AND id != ?',
            [trade.user_id, trade.id]
        );
        const remainingOpenPnL = parseFloat(updatedOpenTrades[0]?.total_pnl || 0);
        const newTotalPnL = remainingOpenPnL + pnl;
        const newLossPercentage = newTotalPnL < 0 ? Math.abs(newTotalPnL) / userBalance * 100 : 0;

        if (newTotalPnL < 0 && newLossPercentage >= notifyPct && newLossPercentage < autoClosePct) {
            console.log(`[closeTrade] 🔔 NOTIFY CLIENT: Loss=${Math.abs(newTotalPnL).toFixed(2)}, LossPct=${newLossPercentage.toFixed(2)}%, NotifyThreshold=${notifyPct}%`);
            // Send notification to client
            try {
                await db.execute(
                    'INSERT INTO notifications (user_id, message, type, created_at) VALUES (?, ?, ?, NOW())',
                    [
                        trade.user_id,
                        `⚠️ Account losses have reached ${newLossPercentage.toFixed(2)}% of ledger balance. Current loss: ₹${Math.abs(newTotalPnL).toFixed(2)}`,
                        'LOSS_WARNING'
                    ]
                );
            } catch (e) {
                console.error('[closeTrade] Error creating notification:', e);
            }
        }

        // Release margin + Add/Subtract PnL - Deduct brokerage and swap
        const balanceChange = pnl + marginToRelease - brokerage - swap;

        await db.execute(
            'UPDATE trades SET status = "CLOSED", exit_price = ?, exit_time = NOW(), pnl = ?, brokerage = ?, swap = ? WHERE id = ?',
            [finalExitPrice, pnl, brokerage, swap, req.params.id]
        );

        // Update User Balance
        await db.execute(
            'UPDATE users SET balance = balance + ? WHERE id = ?',
            [balanceChange, trade.user_id]
        );

        console.log(`✅ Trade ${trade.id} closed. PnL: ${pnl}, Margin Released: ${marginToRelease}, Brokerage: ${brokerage}, Swap: ${swap}, Balance Change: ${balanceChange}`);

        // Log the action (Audit)
        await logAction(req.user.id || trade.user_id, 'CLOSE_TRADE', 'trades', `Closed trade ID #${trade.id} @ ${finalExitPrice}. PnL: ${pnl}, Brokerage: ${brokerage}, Swap: ${swap}`);

        // Clear cache on trade close (Option A - immediate consistency)
        try {
            await invalidateCache(`m2m_${trade.user_id}_TRADER`);
            await invalidateCache(`m2m_${trade.user_id}_SUPERADMIN`);
            console.log(`[Cache] Cleared trade cache for user ${trade.user_id}`);
        } catch (e) {
            console.log(`[Cache] Clear failed but trade closed`);
        }

        res.json({
            message: 'Trade closed successfully',
            pnl,
            marginReleased: marginToRelease,
            brokerage,
            swap,
            newBalanceChange: balanceChange
        });
    } catch (err) {
        console.error('❌ Close Trade Error:', err);
        res.status(500).send('Server Error');
    }
};

/**
 * Soft Delete Trade (Audit Trail) — refunds margin + PnL back to user
 */
const deleteTrade = async (req, res) => {
    try {
        // Verify transaction password if provided
        if (req.body && req.body.transactionPassword) {
            const [users] = await db.execute('SELECT transaction_password FROM users WHERE id = ?', [req.user.id]);
            if (users.length && users[0].transaction_password) {
                const match = await bcrypt.compare(req.body.transactionPassword, users[0].transaction_password);
                if (!match) return res.status(403).json({ message: 'Invalid transaction password' });
            }
        }

        const [trades] = await db.execute('SELECT * FROM trades WHERE id = ?', [req.params.id]);
        if (trades.length === 0) return res.status(404).json({ message: 'Trade not found' });

        const trade = trades[0];
        if (trade.status === 'DELETED') return res.status(400).json({ message: 'Trade already deleted' });

        // Refund: margin + PnL (for CLOSED trades) or just margin (for OPEN trades)
        const marginToRefund = parseFloat(trade.margin_used || 0);
        const pnlToRefund = trade.status === 'CLOSED' ? parseFloat(trade.pnl || 0) : 0;
        const balanceRefund = marginToRefund + pnlToRefund;

        await db.execute('UPDATE trades SET status = "DELETED", exit_time = NOW() WHERE id = ?', [req.params.id]);

        if (balanceRefund !== 0) {
            await db.execute('UPDATE users SET balance = balance + ? WHERE id = ?', [balanceRefund, trade.user_id]);
        }

        await logAction(req.user.id, 'DELETE_TRADE', 'trades', `Deleted trade #${req.params.id}. Refunded margin: ${marginToRefund}, PnL: ${pnlToRefund}`);

        // Clear cache on trade delete (Option A)
        try {
            await invalidateCache(`m2m_${trade.user_id}_TRADER`);
            await invalidateCache(`m2m_${trade.user_id}_SUPERADMIN`);
        } catch (e) {
            console.log(`[Cache] Clear failed but trade deleted`);
        }

        res.json({ message: 'Trade deleted and refunded', marginRefunded: marginToRefund, pnlRefunded: pnlToRefund });
    } catch (err) {
        console.error('Delete Trade Error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
};

/**
 * Update Trade (modify entry_price, exit_price, qty)
 */
const updateTrade = async (req, res) => {
    try {
        const { entry_price, exit_price, qty, transactionPassword } = req.body;

        // Verify transaction password
        if (transactionPassword) {
            const [users] = await db.execute('SELECT transaction_password FROM users WHERE id = ?', [req.user.id]);
            if (users.length && users[0].transaction_password) {
                const match = await bcrypt.compare(transactionPassword, users[0].transaction_password);
                if (!match) return res.status(403).json({ message: 'Invalid transaction password' });
            }
        }

        const [trades] = await db.execute('SELECT * FROM trades WHERE id = ?', [req.params.id]);
        if (trades.length === 0) return res.status(404).json({ message: 'Trade not found' });

        const trade = trades[0];

        // Build dynamic update
        const updates = [];
        const params = [];

        if (qty !== undefined && qty !== '' && qty !== null) {
            const newQty = parseInt(qty);
            if (newQty <= 0) return res.status(400).json({ message: 'Quantity must be positive' });
            updates.push('qty = ?');
            params.push(newQty);

            // Recalculate margin: price * qty * 0.1
            const price = entry_price ? parseFloat(entry_price) : parseFloat(trade.entry_price);
            const newMargin = price * newQty * 0.1;
            const oldMargin = parseFloat(trade.margin_used || 0);
            const marginDiff = newMargin - oldMargin;

            updates.push('margin_used = ?');
            params.push(newMargin);

            // Adjust user balance for margin difference
            if (marginDiff !== 0) {
                await db.execute('UPDATE users SET balance = balance - ? WHERE id = ?', [marginDiff, trade.user_id]);
            }
        }

        if (entry_price !== undefined && entry_price !== '' && entry_price !== null) {
            updates.push('entry_price = ?');
            params.push(parseFloat(entry_price));
        }

        if (exit_price !== undefined && exit_price !== '' && exit_price !== null) {
            updates.push('exit_price = ?');
            params.push(parseFloat(exit_price));

            // Recalculate PnL if both entry and exit price exist
            const entryP = entry_price ? parseFloat(entry_price) : parseFloat(trade.entry_price);
            const exitP = parseFloat(exit_price);
            const q = qty ? parseInt(qty) : trade.qty;
            const pnl = trade.type === 'BUY' ? (exitP - entryP) * q : (entryP - exitP) * q;
            updates.push('pnl = ?');
            params.push(pnl);
        }

        if (updates.length === 0) return res.status(400).json({ message: 'No fields to update' });

        params.push(req.params.id);
        await db.execute(`UPDATE trades SET ${updates.join(', ')} WHERE id = ?`, params);

        await logAction(req.user.id, 'UPDATE_TRADE', 'trades', `Updated trade #${req.params.id}: ${updates.map(u => u.split(' =')[0]).join(', ')}`);

        res.json({ message: 'Trade updated successfully' });
    } catch (err) {
        console.error('Update Trade Error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
};

/**
 * Restore Trade — reopens a CLOSED trade by removing exit data
 * Reverses the close: removes exit_price, exit_time, resets PnL, re-deducts margin from balance
 */
const restoreTrade = async (req, res) => {
    try {
        const { transactionPassword } = req.body;

        // Verify transaction password
        if (transactionPassword) {
            const [users] = await db.execute('SELECT transaction_password FROM users WHERE id = ?', [req.user.id]);
            if (users.length && users[0].transaction_password) {
                const match = await bcrypt.compare(transactionPassword, users[0].transaction_password);
                if (!match) return res.status(403).json({ message: 'Invalid transaction password' });
            }
        }

        const [trades] = await db.execute('SELECT * FROM trades WHERE id = ?', [req.params.id]);
        if (trades.length === 0) return res.status(404).json({ message: 'Trade not found' });

        const trade = trades[0];
        if (trade.status !== 'CLOSED') {
            return res.status(400).json({ message: 'Only CLOSED trades can be restored' });
        }

        // Reverse the close: take back PnL + margin that was released, then re-lock margin
        const pnl = parseFloat(trade.pnl || 0);
        const margin = parseFloat(trade.margin_used || 0);
        // On close: balance += pnl + margin. To reverse: balance -= (pnl + margin) then balance += 0 (margin stays locked)
        // Net: balance -= pnl (refund the PnL reversal, keep margin locked)
        const balanceDeduction = pnl; // Remove the PnL that was credited on close

        // Reopen the trade
        await db.execute(
            'UPDATE trades SET status = "OPEN", exit_price = NULL, exit_time = NULL, pnl = 0 WHERE id = ?',
            [req.params.id]
        );

        // Reverse balance: deduct the PnL that was added on close
        if (balanceDeduction !== 0) {
            await db.execute('UPDATE users SET balance = balance - ? WHERE id = ?', [balanceDeduction, trade.user_id]);
        }

        await logAction(req.user.id, 'RESTORE_TRADE', 'trades', `Restored trade #${req.params.id} to OPEN. PnL reversed: ${pnl}`);

        res.json({ message: 'Trade restored to OPEN', pnlReversed: pnl });
    } catch (err) {
        console.error('Restore Trade Error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
};

/**
 * Modify Pending Order — trader can modify their own pending orders (qty, price)
 */
const modifyPendingOrder = async (req, res) => {
    try {
        const { qty, price } = req.body;
        const tradeId = req.params.id;
        const userId = req.user.id;

        const [trades] = await db.execute('SELECT * FROM trades WHERE id = ?', [tradeId]);
        if (trades.length === 0) return res.status(404).json({ message: 'Trade not found' });

        const trade = trades[0];

        // Trader can only modify their own orders
        if (trade.user_id !== userId) {
            return res.status(403).json({ message: 'Not authorized to modify this order' });
        }

        // Only pending orders can be modified
        if (trade.status !== 'PENDING' && trade.is_pending !== 1) {
            return res.status(400).json({ message: 'Only pending orders can be modified' });
        }

        const updates = [];
        const params = [];

        if (qty !== undefined && qty !== null) {
            updates.push('qty = ?');
            params.push(parseInt(qty));
        }
        if (price !== undefined && price !== null) {
            updates.push('entry_price = ?');
            params.push(parseFloat(price));
        }

        if (updates.length === 0) {
            return res.status(400).json({ message: 'Nothing to update' });
        }

        params.push(tradeId);
        await db.execute(`UPDATE trades SET ${updates.join(', ')} WHERE id = ?`, params);

        res.json({ message: 'Pending order modified successfully' });
    } catch (err) {
        console.error('Modify Pending Order Error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
};

module.exports = { placeOrder, getTrades, getTradeById, getGroupTrades, closeTrade, deleteTrade, updateTrade, restoreTrade, modifyPendingOrder };
