const MarginUtils = {
    /**
     * Calculates the total holding margin required for a list of open trades.
     * Uses segments-specific logic (MCX, Equity, Options, Comex, etc.)
     */
    calculateTotalRequiredHoldingMargin(trades, clientConfig) {
        let totalMargin = 0;

        for (const trade of trades) {
            const qtyNum = parseFloat(trade.qty || 0);
            const entryPrice = parseFloat(trade.entry_price || 0);
            const turnover = entryPrice * qtyNum;
            let tradeMargin = 0;

            if (trade.market_type === 'MCX') {
                const brokerMargins = clientConfig.mcxLotMargins || {};
                const baseScrip = this.getMcxBaseScrip(trade.symbol, brokerMargins);
                
                // Priority 1: Scrip-specific Lot-wise HOLDING Margin (Fixed Amount)
                const holdingMarginValue = parseFloat(brokerMargins[baseScrip]?.HOLDING ?? 0);
                const lotSize = parseFloat(brokerMargins[baseScrip]?.LOT ?? 1);

                if (holdingMarginValue > 0) {
                    tradeMargin = holdingMarginValue * (qtyNum / (lotSize || 1));
                    console.log(`[MarginCalc] MCX Lot-wise: Scrip=${baseScrip}, Margin=${holdingMarginValue}, Qty=${qtyNum}, Result=${tradeMargin}`);
                } else {
                    // Priority 2: Global Exposure-based Calculation (HOLDING)
                    const holdingExposure = parseInt(clientConfig.mcxHoldingMargin || 100);
                    const exposureType = clientConfig.mcxExposureType || 'per_turnover';

                    if (exposureType === 'per_turnover') {
                        tradeMargin = turnover / (holdingExposure || 1);
                    } else {
                        tradeMargin = holdingExposure * qtyNum;
                    }
                    console.log(`[MarginCalc] MCX Exposure: Scrip=${baseScrip}, Exposure=${holdingExposure}, Type=${exposureType}, Result=${tradeMargin}`);
                }
            } else if (trade.market_type === 'EQUITY') {
                const holdingExposure = parseInt(clientConfig.equityHoldingMargin || 100);
                tradeMargin = turnover / (holdingExposure || 1);
            } else if (trade.market_type === 'OPTIONS') {
                const symbol = (trade.symbol || '').toUpperCase();
                let holdingExposure = 2; // Default 2x

                if (symbol.includes('NIFTY') || symbol.includes('BANKNIFTY')) {
                    holdingExposure = parseInt(clientConfig.optionsIndexHolding || 2);
                } else if (symbol.includes('MCX') || symbol.includes('GOLD') || symbol.includes('SILVER')) {
                    holdingExposure = parseInt(clientConfig.optionsMcxHolding || 2);
                } else {
                    holdingExposure = parseInt(clientConfig.optionsEquityHolding || 2);
                }
                tradeMargin = turnover / (holdingExposure || 1);
            } else if (trade.market_type === 'COMEX') {
                const comexConfig = clientConfig.comexConfig || {};
                const holdingExposure = parseInt(comexConfig.holdingMargin || 100);
                tradeMargin = turnover / (holdingExposure || 1);
            } else if (trade.market_type === 'FOREX') {
                const forexConfig = clientConfig.forexConfig || {};
                const holdingExposure = parseInt(forexConfig.holdingMargin || 100);
                tradeMargin = turnover / (holdingExposure || 1);
            } else if (trade.market_type === 'CRYPTO') {
                const cryptoConfig = clientConfig.cryptoConfig || {};
                const holdingExposure = parseInt(cryptoConfig.holdingMargin || 100);
                tradeMargin = turnover / (holdingExposure || 1);
            }

            // Fallback for any missed segments or 0 results (Ensure something is blocked)
            if (tradeMargin <= 0 && turnover > 0) {
                tradeMargin = turnover * 0.1; // 10% default for safety
            }

            totalMargin += tradeMargin;
        }

        return totalMargin;
    },

    getMcxBaseScrip(symbol, configKeys) {
        if (!symbol) return '';
        const s = symbol.split(':').pop().toUpperCase();
        const cleanS = s.replace(/\s+/g, '');
        
        // 1. Try to match keys in the config directly (Longest match first)
        // This handles cases like "CRUDEOIL MINI" vs "CRUDEOIL"
        if (configKeys) {
            const sortedKeys = Object.keys(configKeys).sort((a, b) => b.length - a.length);
            for (const key of sortedKeys) {
                const cleanKey = key.replace(/\s+/g, '').toUpperCase();
                if (cleanS.startsWith(cleanKey)) return key;
            }
        }

        // 2. Generic prefix match
        const match = s.match(/^([A-Z]+)/);
        return match ? match[1] : s;
    }
};

module.exports = MarginUtils;
