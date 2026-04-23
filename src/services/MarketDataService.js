const { KiteTicker } = require('kiteconnect');
const socketManager = require('../websocket/SocketManager');
const EventEmitter = require('events');
const WebSocket = require('ws');
const axios = require('axios');

// ── Binance Config ──
const BINANCE_REST_BASE = 'https://api.binance.com/api/v3';
const BINANCE_WS_BASE = 'wss://stream.binance.com:9443/stream?streams=';

let CRYPTO_SYMBOLS_LIST = [];
let FOREX_SYMBOLS_LIST = [];


let SYMBOL_META = {};

// ── Twelve Data Config (Forex Only) ──
const TWELVE_DATA_KEY = process.env.TWELVE_DATA_API_KEY || 'demo';
const TWELVE_BASE = 'https://api.twelvedata.com';

/**
 * Optimized MarketDataService
 * - Production-level accuracy for Binance (miniTicker + bookTicker)
 * - Efficient batched broadcasting (150ms)
 * - Memory-efficient state management with prefixed symbols
 * - Intelligent reconnect and error handling
 */
class MarketDataService extends EventEmitter {
    constructor() {
        super();
        this.ticker = null;
        this.isConnecting = false;

        // Unified State Management
        // Key format: "CRYPTO:BTC/USD", "FOREX:XAU/USD", "NSE:RELIANCE"
        this.prices = {};
        this.dirtySymbols = new Set();

        // Subscription Sets
        this.subscribedTokens = new Set();
        this.subscribedSymbols = new Set();
        this.instrumentMap = {}; // token -> symbol

        // Binance Connection State
        this.binanceWs = null;
        this.isBinanceActive = false;
        this.binanceReconnectAttempts = 0;
        this.binanceError = null; // Track Binance specific errors
        this.binanceToFrontend = {};
        this.frontendToBinance = {};

        // Forex Polling State
        this.forexInterval = null;

        // Broadcasting Optimization
        this.broadcastInterval = 150; // ms
        this.broadcastTimer = null;

        this._initMappings();
        this._loadSymbolsFromDb();
        this._startBroadcastLoop();
    }

    async _loadSymbolsFromDb() {
        try {
            const db = require('../config/db');
            
            // Load Crypto
            const [cryptoRows] = await db.execute(`
                SELECT symbol FROM market_group_items mgi 
                JOIN market_groups mg ON mgi.group_id = mg.id 
                WHERE mg.name = 'CRYPTO'
            `);
            CRYPTO_SYMBOLS_LIST = cryptoRows.map(r => r.symbol);

            // Load Forex
            const [forexRows] = await db.execute(`
                SELECT symbol FROM market_group_items mgi 
                JOIN market_groups mg ON mgi.group_id = mg.id 
                WHERE mg.name = 'FOREX'
            `);
            FOREX_SYMBOLS_LIST = forexRows.map(r => r.symbol);

            // Load All Metadata
            const [metaRows] = await db.execute(`
                SELECT symbol, name, category FROM market_group_items 
                WHERE category IS NOT NULL
            `);
            const newMeta = {};
            metaRows.forEach(r => {
                newMeta[r.symbol] = { name: r.name, category: r.category };
            });
            SYMBOL_META = newMeta;

            console.log(`✅ Loaded ${CRYPTO_SYMBOLS_LIST.length} Crypto, ${FOREX_SYMBOLS_LIST.length} Forex, and ${Object.keys(SYMBOL_META).length} Meta entries from DB`);
            
            this._initMappings(); // Re-run mappings with new symbols
        } catch (err) {
            console.error('❌ Failed to load market data symbols from DB:', err.message);
        }
    }

    _initMappings() {
        CRYPTO_SYMBOLS_LIST.forEach(sym => {
            const bSym = sym.replace("/", "") + "T"; // BTC/USD -> BTCUSDT
            this.frontendToBinance[sym] = bSym.toLowerCase();
            this.binanceToFrontend[bSym.toUpperCase()] = sym;
        });
    }

    /**
     * Start the broadcasting loop to batch updates
     */
    _startBroadcastLoop() {
        if (this.broadcastTimer) return;
        this.broadcastTimer = setInterval(() => {
            if (this.dirtySymbols.size === 0) return;

            const updates = {};
            this.dirtySymbols.forEach(sym => {
                if (this.prices[sym]) {
                    updates[sym] = { ...this.prices[sym] };
                }
            });
            this.dirtySymbols.clear();

            const io = socketManager.getIo();
            if (io) {
                io.emit('price_update', updates);
            }
            this.emit('update', updates);
        }, this.broadcastInterval);
    }

    // ══════════════════════════════════════════════════════
    //   ZERODHA (KITE) INTEGRATION
    // ══════════════════════════════════════════════════════

    async init(userId) {
        if (this.ticker || this.isConnecting) return;
        this.isConnecting = true;
        try {
            const repo = require('../repositories/KiteRepository');
            const userSession = await repo.getSessionByUserId(userId);

            if (!userSession || !userSession.access_token) {
                this.isConnecting = false;
                return;
            }

            this.ticker = new KiteTicker({
                api_key: process.env.KITE_API_KEY,
                access_token: userSession.access_token
            });

            this.ticker.autoReconnect(true, 50, 5);

            this.ticker.on('connect', () => {
                console.log('📈 Zerodha Ticker Connected');
                this.resubscribe();
            });

            this.ticker.on('ticks', (ticks) => {
                this.handleTicks(ticks);
            });

            this.ticker.on('error', (err) => {
                console.error('⚠️ Zerodha Ticker Error:', err.message);
            });

            this.ticker.connect();
        } catch (err) {
            console.error('⚠️ Zerodha Ticker init failed:', err.message);
        } finally {
            this.isConnecting = false;
        }
    }

    handleTicks(ticks) {
        ticks.forEach(tick => {
            const token = String(tick.instrument_token);
            const symbol = this.instrumentMap[token] || token;
            const prev = this.prices[symbol] || {};

            const buy0 = tick.depth?.buy?.[0]?.price;
            const sell0 = tick.depth?.sell?.[0]?.price;
            const hasBid = buy0 != null && Number.isFinite(Number(buy0));
            const hasAsk = sell0 != null && Number.isFinite(Number(sell0));

            const data = {
                ...prev,
                symbol,
                ltp: tick.last_price != null ? tick.last_price : prev.ltp,
                bid: hasBid ? Number(buy0) : prev.bid,
                ask: hasAsk ? Number(sell0) : prev.ask,
                change: tick.net_change != null ? tick.net_change : prev.change,
                volume: tick.volume_traded != null ? tick.volume_traded : prev.volume,
                ohlc: tick.ohlc && Object.keys(tick.ohlc).length ? tick.ohlc : (prev.ohlc || {}),
                depth: tick.depth && (tick.depth.buy?.length || tick.depth.sell?.length) ? tick.depth : (prev.depth || {}),
                type: (symbol.startsWith('NSE') || symbol.startsWith('NFO') || symbol.startsWith('MCX')) ? symbol.split(':')[0] : (prev.type || 'NSE')
            };

            this.prices[symbol] = data;
            this.dirtySymbols.add(symbol);
        });
    }

    subscribe(symbol, token) {
        if (!token) {
            this.subscribedSymbols.add(symbol);
            return;
        }

        const sToken = String(token);
        this.instrumentMap[sToken] = symbol;
        this.subscribedTokens.add(sToken);

        if (this.ticker && this.ticker.connected) {
            this.ticker.subscribe([parseInt(sToken)]);
            this.ticker.setMode(this.ticker.modeFull, [parseInt(sToken)]);
        }
    }

    bulkSubscribe(items = []) {
        if (!Array.isArray(items) || items.length === 0) return;

        const tokenNums = [];
        for (const item of items) {
            if (!item?.symbol) continue;
            if (!item.token) {
                this.subscribe(item.symbol);
                continue;
            }

            const sToken = String(item.token);
            this.instrumentMap[sToken] = item.symbol;
            this.subscribedTokens.add(sToken);
            tokenNums.push(parseInt(sToken, 10));
        }

        if (this.ticker && this.ticker.connected && tokenNums.length > 0) {
            this.ticker.subscribe(tokenNums);
            this.ticker.setMode(this.ticker.modeFull, tokenNums);
        }
    }

    startMockEngine() {
        console.log('ℹ️ Mock Engine requested but disabled in favor of real feeds.');
    }

    stopMockEngine() {
        // Placeholder
    }

    resubscribe() {
        if (!this.ticker || !this.ticker.connected) return;
        const tokens = Array.from(this.subscribedTokens).map(t => parseInt(t));
        if (tokens.length > 0) {
            this.ticker.subscribe(tokens);
            this.ticker.setMode(this.ticker.modeFull, tokens);
        }
    }

    // ══════════════════════════════════════════════════════
    //   BINANCE INTEGRATION (Crypto)
    // ══════════════════════════════════════════════════════

    async startCryptoForex() {
        if (this.isBinanceActive) return;
        this.isBinanceActive = true;
        console.log('🌐 Starting Optimized Binance (Crypto) + Twelve Data (Forex) feeds');

        // 1. Snapshot via REST for initial LTP and 24h stats
        await this._fetchInitialBinanceData();

        // 2. Connect WebSocket for Real-time LTP/Bid/Ask
        this._connectBinanceWs();

        // 3. Start Forex loop
        if (!this.forexInterval) {
            this.forexInterval = setInterval(() => this._fetchForexData(), 15000);
            this._fetchForexData();
        }
    }

    async _fetchInitialBinanceData() {
        try {
            this.binanceError = null; // Reset
            const bSymbols = CRYPTO_SYMBOLS_LIST.map(s => this.frontendToBinance[s].toUpperCase());
            const symbolsParam = JSON.stringify(bSymbols);
            const url = `${BINANCE_REST_BASE}/ticker/24hr?symbols=${encodeURIComponent(symbolsParam)}`;

            const response = await axios.get(url);

            if (response.data && Array.isArray(response.data)) {
                response.data.forEach(item => {
                    const frontendSym = this.binanceToFrontend[item.symbol];
                    if (!frontendSym) return;

                    const symbolKey = `CRYPTO:${frontendSym}`;
                    const meta = SYMBOL_META[frontendSym] || { name: frontendSym, category: 'crypto' };

                    this.prices[symbolKey] = {
                        ...this.prices[symbolKey],
                        symbol: symbolKey,
                        name: meta.name,
                        category: meta.category,
                        type: 'CRYPTO',
                        ltp: parseFloat(item.lastPrice),
                        change: parseFloat(item.priceChange),
                        chg_pct: item.priceChangePercent,
                        direction: parseFloat(item.priceChange) >= 0 ? 'up' : 'down'
                    };
                    this.dirtySymbols.add(symbolKey);
                });
            }
        } catch (err) {
            this.binanceError = `Binance Blocked: ${err.message}`;
            console.error('⚠️ Binance Snapshot Error:', err.message);
        }
    }

    _connectBinanceWs() {
        if (!this.isBinanceActive) return;

        const bSymbols = CRYPTO_SYMBOLS_LIST.map(s => this.frontendToBinance[s]);
        const streams = bSymbols.map(s => `${s}@miniTicker/${s}@bookTicker`).join('/');
        const url = `${BINANCE_WS_BASE}${streams}`;

        if (this.binanceWs) {
            try { this.binanceWs.close(); } catch (e) { }
        }

        this.binanceWs = new WebSocket(url);

        this.binanceWs.on('open', () => {
            console.log('⚡ Binance WebSocket Connected');
            this.binanceReconnectAttempts = 0;
        });

        this.binanceWs.on('message', (data) => {
            try {
                this._handleBinanceMessage(JSON.parse(data));
            } catch (e) {
                console.error('⚠️ Binance Msg Parse Error:', e.message);
            }
        });

        this.binanceWs.on('error', (err) => {
            console.error('⚠️ Binance WS Error:', err.message);
        });

        this.binanceWs.on('close', () => {
            if (this.isBinanceActive) {
                const delay = Math.min(1000 * Math.pow(2, this.binanceReconnectAttempts), 30000);
                console.log(`🔄 Binance WS closed. Reconnecting in ${delay / 1000}s...`);
                setTimeout(() => {
                    this.binanceReconnectAttempts++;
                    this._connectBinanceWs();
                }, delay);
            }
        });
    }

    _handleBinanceMessage(msg) {
        if (!msg.data || !msg.stream) return;

        const streamParts = msg.stream.split('@');
        const bSymbol = streamParts[0].toUpperCase();
        const type = streamParts[1]; // miniTicker or bookTicker
        const frontendSym = this.binanceToFrontend[bSymbol];

        if (!frontendSym) return;

        const symbolKey = `CRYPTO:${frontendSym}`;
        const current = this.prices[symbolKey] || {
            symbol: symbolKey,
            type: 'CRYPTO',
            category: 'crypto',
            name: SYMBOL_META[frontendSym]?.name || frontendSym,
            ltp: 0, bid: 0, ask: 0, change: 0, chg_pct: '0.00'
        };

        const data = msg.data;
        let changed = false;

        if (type === 'miniTicker') {
            // Requirement 1: miniTicker for LTP and Change
            const ltp = parseFloat(data.c);
            const open = parseFloat(data.o);
            const change = ltp - open;
            const chg_pct = open !== 0 ? ((change / open) * 100).toFixed(2) : '0.00';

            if (current.ltp !== ltp || current.change !== change) {
                current.ltp = ltp;
                current.change = parseFloat(change.toFixed(4));
                current.chg_pct = chg_pct;
                current.direction = change >= 0 ? 'up' : 'down';
                changed = true;
            }
        } else if (type === 'bookTicker') {
            // Requirement 1: bookTicker for Bid/Ask
            const bid = parseFloat(data.b);
            const ask = parseFloat(data.a);

            // Requirement 2: Ensure spread is correct (Ask > Bid)
            if (bid > 0 && ask > 0 && ask >= bid) {
                if (current.bid !== bid || current.ask !== ask) {
                    current.bid = bid;
                    current.ask = ask;
                    changed = true;
                }
            } else if (bid > 0 && ask > 0) {
                // Log invalid data cases
                console.warn(`[Binance] Invalid Spread for ${bSymbol}: Bid=${bid}, Ask=${ask}`);
            }
        }

        if (changed) {
            this.prices[symbolKey] = current;
            this.dirtySymbols.add(symbolKey);
        }
    }

    // ══════════════════════════════════════════════════════
    //   FOREX INTEGRATION
    // ══════════════════════════════════════════════════════

    async _fetchForexData() {
        const symbols = FOREX_SYMBOLS_LIST.join(',');
        try {
            const url = `${TWELVE_BASE}/quote?symbol=${symbols}&apikey=${TWELVE_DATA_KEY}`;
            const response = await axios.get(url);
            const data = response.data;

            for (const [sym, val] of Object.entries(data)) {
                if (!val || (!val.price && !val.close)) continue;

                const symbolKey = `FOREX:${sym}`;
                const meta = SYMBOL_META[sym] || { name: sym, category: 'forex' };

                this.prices[symbolKey] = {
                    symbol: symbolKey,
                    name: meta.name,
                    category: meta.category,
                    type: 'FOREX',
                    ltp: parseFloat(val.close || val.price || 0),
                    bid: parseFloat(val.bid || val.close || 0),
                    ask: parseFloat(val.ask || val.close || 0),
                    change: parseFloat(val.change || 0),
                    chg_pct: val.percent_change || '0.00',
                    direction: parseFloat(val.change) >= 0 ? 'up' : 'down'
                };
                this.dirtySymbols.add(symbolKey);
            }
        } catch (err) {
            if (!err.message?.includes('429')) {
                console.warn('⚠️ Twelve Data Forex error:', err.message);
            }
        }
    }

    // ══════════════════════════════════════════════════════
    //   PUBLIC GETTERS
    // ══════════════════════════════════════════════════════

    getPrice(symbol) {
        return this.prices[symbol] || null;
    }

    getPricesBatch(symbols) {
        const result = {};
        if (!Array.isArray(symbols)) return result;
        symbols.forEach(sym => {
            if (this.prices[sym]) result[sym] = this.prices[sym];
        });
        return result;
    }

    getCryptoPrices() {
        return CRYPTO_SYMBOLS_LIST.map(sym => this.prices[`CRYPTO:${sym}`]).filter(Boolean);
    }

    getBinanceError() {
        return this.binanceError;
    }

    getForexPrices() {
        return FOREX_SYMBOLS_LIST.map(sym => this.prices[`FOREX:${sym}`]).filter(Boolean);
    }

    stopCryptoForex() {
        this.isBinanceActive = false;
        if (this.binanceWs) {
            this.binanceWs.close();
            this.binanceWs = null;
        }
        if (this.forexInterval) {
            clearInterval(this.forexInterval);
            this.forexInterval = null;
        }
        console.log('🛑 Stopped Binance + Forex Integration');
    }

    shutdown() {
        if (this.ticker) {
            this.ticker.disconnect();
            this.ticker = null;
        }
        if (this.broadcastTimer) {
            clearInterval(this.broadcastTimer);
            this.broadcastTimer = null;
        }
        this.stopCryptoForex();
    }
}

module.exports = new MarketDataService();
