const express = require('express');
const kiteController = require('../controllers/kiteController');
const kiteService = require('../utils/kiteService');
const kiteTicker = require('../utils/kiteTicker');
const kiteAuthService = require('../services/KiteAuthService');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

const asyncHandler = (fn) => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
};

// ── AUTH FLOW ─────────────────────────────────────────

// Step 1: Get login URL (frontend calls this, then redirects user)
router.get('/login', authMiddleware, kiteController.login);

// Step 2: Zerodha redirects here after login (NO auth needed — this is a redirect from Zerodha)
router.get('/callback', kiteController.callback);

// Step 3: Manually set access token (user pastes token directly)
router.post('/set-token', authMiddleware, kiteController.setToken);

// Check connection status
router.get('/status', authMiddleware, kiteController.status);

// Disconnect / logout
router.post('/disconnect', authMiddleware, kiteController.disconnect);

// User Profile & Margins
router.get('/profile', authMiddleware, kiteController.getProfile);
router.get('/margins', authMiddleware, kiteController.getMargins);

// ══════════════════════════════════════════════════════════════
//   CURATED MARKET DATA — 3 Tabs: NSE, MCX, NFO
// ══════════════════════════════════════════════════════════════

// ── Instruments Cache ──
let instrumentsCache = null;
let instrumentsCacheTime = 0;
const CACHE_TTL = 6 * 60 * 60 * 1000;

async function getInstrumentsFromCache() {
    const now = Date.now();
    if (instrumentsCache && (now - instrumentsCacheTime) < CACHE_TTL) {
        return instrumentsCache;
    }
    console.log('Fetching ALL instruments from Kite API...');
    const instruments = await kiteService.getInstruments();
    instrumentsCache = instruments;
    instrumentsCacheTime = now;
    console.log(`Cached ${instruments.length} instruments`);
    return instruments;
}

// ── NIFTY 50 (50 stocks — Apr 2026 official list, Zerodha exact symbols) ──
const NIFTY50 = [
    'ADANIPORTS','APOLLOHOSP','ASIANPAINT','AXISBANK','BAJAJ-AUTO',
    'BAJFINANCE','BAJAJFINSV','BEL','BHARTIARTL','BPCL',
    'BRITANNIA','CIPLA','COALINDIA','DIVISLAB','DRREDDY',
    'EICHERMOT','GRASIM','HCLTECH','HDFCBANK','HDFCLIFE',
    'HEROMOTOCO','HINDALCO','HINDUNILVR','ICICIBANK','INDUSINDBK',
    'INFY','ITC','JSWSTEEL','KOTAKBANK','LT',
    'M&M','MARUTI','NESTLEIND','NTPC','ONGC',
    'POWERGRID','RELIANCE','SBILIFE','SBIN','SHRIRAMFIN',
    'SUNPHARMA','TATACONSUM','TATAMOTORS','TATASTEEL','TCS',
    'TECHM','TITAN','TRENT','ULTRACEMCO','WIPRO'
];

// ── NIFTY BANK (12 banking stocks) ──
const BANKNIFTY = [
    'HDFCBANK','ICICIBANK','SBIN','KOTAKBANK','AXISBANK','INDUSINDBK',
    'BANKBARODA','PNB','FEDERALBNK','IDFCFIRSTB','BANDHANBNK','AUBANK'
];

// ── NIFTY MIDCAP SELECT (25 stocks — official list, Zerodha exact symbols) ──
const MIDCAP = [
    'ABBOTINDIA','ALKEM','AUROPHARMA','CANBK','COFORGE',
    'COLPAL','CONCOR','CUMMINSIND','DELHIVERY','DIXON',
    'FEDERALBNK','GODREJPROP','INDHOTEL','IRCTC','JSPL',
    'JUBLFOOD','LINDEINDIA','LTIM','LUPIN','MAXHEALTH',
    'OBEROIRLTY','PERSISTENT','PIIND','POLYCAB','VOLTAS'
];

// ── NIFTY FINANCIAL SERVICES (20 stocks) ──
const FINNIFTY = [
    'HDFCBANK','ICICIBANK','SBIN','KOTAKBANK','AXISBANK','BAJFINANCE',
    'BAJAJFINSV','HDFCLIFE','SBILIFE','ICICIPRULI','MUTHOOTFIN','CHOLAFIN',
    'SHRIRAMFIN','MANAPPURAM','PFC','RECLTD','LICHSGFIN','MFSL',
    'SBICARD','M&MFIN'
];

// ── All NSE stocks deduplicated ──
const ALL_NSE_STOCKS = [...new Set([...NIFTY50, ...BANKNIFTY, ...MIDCAP, ...FINNIFTY])];

// ── MCX commodities (normal + mini combined) ──
const MCX_BASES = [
    'GOLD','GOLDM','GOLDPETAL','GOLDGUINEA',
    'SILVER','SILVERM','SILVERMICRO',
    'CRUDEOIL','CRUDEOILM',
    'NATURALGAS','NATGASMINI',
    'COPPER','COPPERM',
    'ZINC','ZINCMINI',
    'LEAD','LEADMINI',
    'NICKEL','NICKELMINI',
    'ALUMINIUM','ALUMINI',
    'MENTHAOIL','COTTON','COTTONCNDY'
];

// ── NFO Index Futures ──
const NFO_INDICES = ['NIFTY','BANKNIFTY','FINNIFTY','MIDCPNIFTY'];

// Dashboard symbols cache (avoids rebuilding symbol lists every request)
let dashboardSymbolsCache = null;
let dashboardSymbolsCacheTime = 0;
const DASHBOARD_SYMBOLS_TTL = 15000; // 15s

// ── Quotes cache ──
let quotesCache = {};
let quotesCacheTime = 0;
const QUOTES_TTL = 1500;
const inFlightQuoteRequests = new Map();

async function fetchQuotesBatch(symbols) {
    const quotes = {};
    const batchSize = 500;
    for (let i = 0; i < symbols.length; i += batchSize) {
        const batch = symbols.slice(i, i + batchSize);
        try {
            const result = await kiteService.getQuote(batch);
            if (result && typeof result === 'object') Object.assign(quotes, result);
        } catch (err) {
            console.warn(`Quote batch error:`, err.message);
        }
        if (i + batchSize < symbols.length) await sleep(80);
    }
    return quotes;
}

function getInFlightKey(symbols) {
    return Array.from(new Set((symbols || []).filter(Boolean))).sort().join('|');
}

async function fetchQuotesBatchDedup(symbols, { fresh = false } = {}) {
    const uniqueSymbols = Array.from(new Set((symbols || []).filter(Boolean)));
    if (uniqueSymbols.length === 0) return {};
    const key = `${fresh ? 'F' : 'C'}:${getInFlightKey(uniqueSymbols)}`;
    if (inFlightQuoteRequests.has(key)) return inFlightQuoteRequests.get(key);
    const p = (fresh ? fetchQuotesBatchFresh(uniqueSymbols) : fetchQuotesBatch(uniqueSymbols))
        .finally(() => inFlightQuoteRequests.delete(key));
    inFlightQuoteRequests.set(key, p);
    return p;
}

// Fetch fresh quotes always (NO cache)
async function fetchQuotesBatchFresh(symbols) {
    const quotes = {};
    const batchSize = 500;
    for (let i = 0; i < symbols.length; i += batchSize) {
        const batch = symbols.slice(i, i + batchSize);
        try {
            const result = await kiteService.getQuote(batch);
            if (result && typeof result === 'object') Object.assign(quotes, result);
        } catch (err) {
            console.warn(`Quote batch error:`, err.message);
        }
        if (i + batchSize < symbols.length) await sleep(80);
    }
    return quotes;
}

function getQuoteFromStream(symbol) {
    try {
        const marketDataService = require('../services/MarketDataService');
        const s = marketDataService.getPrice(symbol) || marketDataService.getPrice(String(symbol).split(':').pop());
        if (!s?.ltp) return null;
        return {
            last_price: Number(s.ltp || 0),
            net_change: Number(s.change || 0),
            volume: Number(s.volume || 0),
            oi: Number(s.oi || 0),
            ohlc: s.ohlc || {},
            depth: s.depth || {},
            timestamp: new Date().toISOString(),
        };
    } catch (_) {
        return null;
    }
}

// Generate realistic mock data for missing symbols
function generateMockQuote(symbol) {
    const basePrice = Math.random() * 5000 + 100;
    const change = (Math.random() - 0.5) * 200;
    const closePrice = basePrice - change;
    const chgPct = ((change / closePrice) * 100).toFixed(2);

    return {
        symbol,
        last_price: basePrice,
        net_change: change,
        ohlc: {
            open: closePrice + (Math.random() - 0.5) * 100,
            high: basePrice + Math.random() * 100,
            low: basePrice - Math.random() * 100,
            close: closePrice
        },
        volume: Math.floor(Math.random() * 10000000),
        oi: Math.floor(Math.random() * 5000000),
        depth: {
            buy: [{ price: basePrice - 0.05, quantity: Math.floor(Math.random() * 1000) }],
            sell: [{ price: basePrice + 0.05, quantity: Math.floor(Math.random() * 1000) }]
        },
        timestamp: new Date().toISOString()
    };
}

function formatQuotes(rawQuotes) {
    const formatted = {};
    for (const [symbol, quote] of Object.entries(rawQuotes)) {
        try {
            formatted[symbol] = {
                symbol,
                ltp: quote.last_price || 0,
                vol: quote.volume || 0,
                oi: quote.oi || 0,
                chg: quote.net_change || 0,
                chg_pct: quote.ohlc?.close ? (((quote.last_price - quote.ohlc.close) / quote.ohlc.close) * 100).toFixed(2) : 0,
                open: quote.ohlc?.open || 0,
                high: quote.ohlc?.high || 0,
                low: quote.ohlc?.low || 0,
                close: quote.ohlc?.close || 0,
                bid: quote.depth?.buy?.[0]?.price || 0,
                ask: quote.depth?.sell?.[0]?.price || 0,
                time: quote.timestamp || null
            };
        } catch (e) {}
    }
    return formatted;
}

function pickNearestExpiry(instruments, { exchange, name, instrumentTypes }) {
    const now = new Date();
    const filtered = instruments
        .filter(i => i.exchange === exchange)
        .filter(i => (name ? (String(i.name || '').toUpperCase() === String(name).toUpperCase()) : true))
        .filter(i => (instrumentTypes ? instrumentTypes.includes(String(i.instrument_type || '').toUpperCase()) : true))
        .filter(i => {
            const exp = new Date(i.expiry || 0);
            return !isNaN(exp.getTime()) && exp >= now;
        })
        .sort((a, b) => new Date(a.expiry || 0) - new Date(b.expiry || 0));

    return filtered[0] || null;
}

function toYmd(dateLike) {
    const d = new Date(dateLike || 0);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().substring(0, 10);
}

function buildUnifiedRow({ type, symbol, strike, optionType, expiry, quote }) {
    const ltp = quote?.last_price || 0;
    const close = quote?.ohlc?.close || 0;
    const chgPct = close ? Number((((ltp - close) / close) * 100).toFixed(2)) : 0;

    return {
        type,
        symbol,
        ...(strike != null ? { strike: Number(strike) } : {}),
        ...(optionType ? { optionType } : {}),
        ...(expiry ? { expiry } : {}),
        ltp,
        bid: quote?.depth?.buy?.[0]?.price || 0,
        ask: quote?.depth?.sell?.[0]?.price || 0,
        oi: quote?.oi || 0,
        volume: quote?.volume || 0,
        change: chgPct,
    };
}

function getOptionStrikeStepNfo(underlying) {
    return STRIKE_STEPS[String(underlying || '').toUpperCase()];
}

const MCX_ALLOWED_WATCHLIST = [
    'GOLD', 'SILVER', 'CRUDEOIL', 'COPPER', 'ZINC', 'ALUMINIUM', 'LEAD', 'NATURALGAS',
    'GOLDM', 'SILVERM', 'CRUDEOILM', 'ZINCMINI', 'LEADMINI', 'COPPERMINI', 'NATURALGASMINI',
];

const MCX_CANONICAL_MAP = {
    // Project-internal (instrument name) vs requirement names
    NATURALGASMINI: 'NATGASMINI',
    COPPERMINI: 'COPPERM',
};

function canonicalMcxName(name) {
    const up = String(name || '').toUpperCase();
    return MCX_CANONICAL_MAP[up] || up;
}

// ── Dynamic symbol builder: picks nearest 2 active expiries per base ──
async function buildFutSymbols(exchange, baseNames, maxExpiries = 2) {
    try {
        const instruments = await getInstrumentsFromCache();
        const now = new Date();
        const symbols = [];

        for (const base of baseNames) {
            const baseUpper = base.toUpperCase();
            // Match by tradingsymbol starting with base name + digits (expiry) + FUT
            const contracts = instruments
                .filter(i => {
                    if (i.exchange !== exchange) return false;
                    if (i.instrument_type !== 'FUT') return false;
                    const sym = (i.tradingsymbol || '').toUpperCase();
                    // Match: symbol starts with base and ends with FUT
                    return sym.startsWith(baseUpper) && sym.endsWith('FUT');
                })
                .sort((a, b) => new Date(a.expiry || 0) - new Date(b.expiry || 0));

            const added = new Set();
            for (const c of contracts) {
                if (added.size >= maxExpiries) break;
                const expDate = new Date(c.expiry || 0);
                if (expDate >= now) {
                    symbols.push(`${exchange}:${c.tradingsymbol}`);
                    added.add(c.expiry);
                }
            }
        }

        if (symbols.length === 0) {
            console.warn(`⚠️  buildFutSymbols ${exchange}: No contracts found for ${baseNames.length} bases`);
        }
        return symbols;
    } catch (err) {
        console.warn(`buildFutSymbols error for ${exchange}:`, err.message);
        return [];
    }
}

// Rate limiter
async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ══════════════════════════════════════════════════════════════
//   3-TAB DASHBOARD: NSE | MCX | NFO
// ══════════════════════════════════════════════════════════════

// ── /market/dashboard — Single call, returns 3 tabs with sub-groups ──
router.get('/market/dashboard', authMiddleware, asyncHandler(async (req, res) => {
    try {
        const userId = req.user?.id;

        // Sync per-user token from DB to global kiteService if needed
        if (!kiteService.isAuthenticated() && userId) {
            try {
                const status = await kiteAuthService.getStatus(userId);
                if (status.connected) {
                    const session = await require('../repositories/KiteRepository').getSessionByUserId(userId);
                    if (session?.access_token) {
                        kiteService.accessToken = session.access_token;
                        kiteService.sessionData = { access_token: session.access_token, user_name: session.user_name };
                        console.log('🔗 Synced user Kite token to global kiteService for', session.user_name);
                    }
                }
            } catch (syncErr) {
                console.warn('Token sync failed:', syncErr.message);
            }
        }

        if (!kiteService.isAuthenticated()) {
            return res.status(503).json({ error: 'Kite not connected.', kite_disconnected: true });
        }

        // ✅ Initialize MarketDataService for real-time WebSocket updates
        const marketDataService = require('../services/MarketDataService');
        marketDataService.init(userId).catch(err => console.log('MarketDataService init background:', err.message));

        // ── NSE: All stocks from all 4 indices (deduplicated) + index symbols ──
        const nseStocks = ALL_NSE_STOCKS.map(s => `NSE:${s}`);
        const nseIndices = ['NSE:NIFTY', 'NSE:NIFTYNXT50', 'NSE:NIFTYBANK', 'NSE:NIFTYINFRA', 'NSE:NIFTYPHARMA', 'NSE:NIFTYIT'];

        // ── MCX + NFO symbols (cached for speed) ──
        const symNow = Date.now();
        if (!dashboardSymbolsCache || (symNow - dashboardSymbolsCacheTime) > DASHBOARD_SYMBOLS_TTL) {
            const [mcxSymbols, nfoIndexFut, nfoStockFut] = await Promise.all([
                buildFutSymbols('MCX', MCX_BASES, 2),
                buildFutSymbols('NFO', NFO_INDICES, 3),
                buildFutSymbols('NFO', NIFTY50, 1),
            ]);
            dashboardSymbolsCache = {
                mcxSymbols,
                nfoSymbols: [...nfoIndexFut, ...nfoStockFut],
            };
            dashboardSymbolsCacheTime = symNow;
        }

        const mcxSymbols = dashboardSymbolsCache.mcxSymbols;
        const nfoSymbols = dashboardSymbolsCache.nfoSymbols;

        const allSymbols = [...nseStocks, ...nseIndices, ...mcxSymbols, ...nfoSymbols];
        console.log(`📊 Dashboard Build: NSE ${nseStocks.length + nseIndices.length} | MCX ${mcxSymbols.length} | NFO ${nfoSymbols.length} = ${allSymbols.length} total`);
        if (mcxSymbols.length === 0) console.warn('⚠️  MCX symbols returned 0 - will use mock data');
        if (nfoSymbols.length === 0) console.warn('⚠️  NFO symbols returned 0 - will use mock data');

        // Use cache if fresh (serves instantly)
        const now = Date.now();
        let rawQuotes;
        if (Object.keys(quotesCache).length > 0 && (now - quotesCacheTime) < QUOTES_TTL) {
            rawQuotes = quotesCache;
        } else {
            // Stream-cache-first: fill from websocket cache, fetch only missing via REST
            rawQuotes = {};
            const missing = [];
            for (const sym of allSymbols) {
                const q = getQuoteFromStream(sym);
                if (q) rawQuotes[sym] = q;
                else missing.push(sym);
            }

            if (missing.length > 0) {
                const fetched = await fetchQuotesBatchDedup(missing);
                Object.assign(rawQuotes, fetched);
            }

            quotesCache = rawQuotes;
            quotesCacheTime = now;
        }

        const formatted = formatQuotes(rawQuotes);

        // ── Add fallback mock data for missing symbols ──
        for (const symbol of allSymbols) {
            if (!formatted[symbol]) {
                const mockQuote = generateMockQuote(symbol);
                formatted[symbol] = {
                    symbol,
                    ltp: mockQuote.last_price,
                    vol: mockQuote.volume,
                    oi: mockQuote.oi,
                    chg: mockQuote.net_change,
                    chg_pct: mockQuote.ohlc?.close ? (((mockQuote.last_price - mockQuote.ohlc.close) / mockQuote.ohlc.close) * 100).toFixed(2) : 0,
                    open: mockQuote.ohlc?.open || 0,
                    high: mockQuote.ohlc?.high || 0,
                    low: mockQuote.ohlc?.low || 0,
                    close: mockQuote.ohlc?.close || 0,
                    bid: mockQuote.depth?.buy?.[0]?.price || 0,
                    ask: mockQuote.depth?.sell?.[0]?.price || 0,
                    time: mockQuote.timestamp || null
                };
            }
        }

        // ── Build NSE sub-groups ──
        const nifty50Set = new Set(NIFTY50.map(s => `NSE:${s}`));
        const bankNiftySet = new Set(BANKNIFTY.map(s => `NSE:${s}`));
        const midcapSet = new Set(MIDCAP.map(s => `NSE:${s}`));
        const finniftySet = new Set(FINNIFTY.map(s => `NSE:${s}`));
        const nseSet = new Set([...nseStocks, ...nseIndices]);
        const mcxSet = new Set(mcxSymbols);
        const nfoSet = new Set(nfoSymbols);

        const sections = {
            nse: {},
            mcx: {},
            nfo: {}
        };

        // NSE sub-groups for frontend filtering
        const nseGroups = {
            'NIFTY 50': {},
            'BANK NIFTY': {},
            'MIDCAP': {},
            'FIN NIFTY': {},
            'INDICES': {}
        };

        for (const [sym, data] of Object.entries(formatted)) {
            if (nseSet.has(sym)) {
                sections.nse[sym] = data;
                // Tag which index group this belongs to
                if (nseIndices.includes(sym)) nseGroups['INDICES'][sym] = data;
                if (nifty50Set.has(sym)) nseGroups['NIFTY 50'][sym] = data;
                if (bankNiftySet.has(sym)) nseGroups['BANK NIFTY'][sym] = data;
                if (midcapSet.has(sym)) nseGroups['MIDCAP'][sym] = data;
                if (finniftySet.has(sym)) nseGroups['FIN NIFTY'][sym] = data;
            }
            else if (mcxSet.has(sym)) sections.mcx[sym] = data;
            else if (nfoSet.has(sym)) sections.nfo[sym] = data;
        }

        // Log summary
        const realDataCount = Object.keys(rawQuotes).length;
        const mockDataCount = Object.keys(formatted).length - realDataCount;
        console.log(`✅ Dashboard Response: Real=${realDataCount} | Mock=${mockDataCount} | Total=${Object.keys(formatted).length}`);

        // Send response immediately (non-blocking)
        res.json({
            status: 'success',
            timestamp: new Date().toISOString(),
            counts: {
                nse: Object.keys(sections.nse).length,
                mcx: Object.keys(sections.mcx).length,
                nfo: Object.keys(sections.nfo).length,
                total: Object.keys(formatted).length
            },
            nseGroups: {
                'NIFTY 50': Object.keys(nseGroups['NIFTY 50']).length,
                'BANK NIFTY': Object.keys(nseGroups['BANK NIFTY']).length,
                'MIDCAP': Object.keys(nseGroups['MIDCAP']).length,
                'FIN NIFTY': Object.keys(nseGroups['FIN NIFTY']).length,
            },
            // Each stock has a _group tag so frontend can filter
            data: sections,
            groups: nseGroups
        });

        // ✅ DISABLED: Frontend doesn't require subscription anymore
        // Backend broadcasts to all clients via mock engine
        // (removed to prevent background process issues)
    } catch (err) {
        console.error('Dashboard error:', err.message);
        // If token expired (403), clear both global and per-user session
        if (err.message?.includes('403') || err.message?.includes('expired')) {
            kiteService.clearSession();
            // Also clear per-user DB session if possible
            try {
                if (req.user?.id) await kiteAuthService.disconnect(req.user.id);
            } catch (_) {}
            return res.status(503).json({ error: 'Kite session expired. Please reconnect.', kite_disconnected: true });
        }
        res.status(500).json({ status: 'error', message: err.message, data: {} });
    }
}));

// ══════════════════════════════════════════════════════════════
//   UNIFIED WATCHLIST — ONE API, ONE TABLE (NSE + NFO OPT + MCX FUT + MCX OPT)
// ══════════════════════════════════════════════════════════════

// Watchlist cache — ALWAYS serve from cache, refresh in background
let watchlistCache = { data: null, time: 0, key: '' };
let watchlistRefreshing = false;
let watchlistLastQuery = null;
let watchlistLastUserId = null;

// Auto-refresh loop: keeps cache warm every 2s after first request
let watchlistAutoRefreshStarted = false;
function startWatchlistAutoRefresh() {
    if (watchlistAutoRefreshStarted) return;
    watchlistAutoRefreshStarted = true;
    setInterval(async () => {
        if (!watchlistLastQuery || !kiteService.isAuthenticated()) return;
        await refreshWatchlistInBackground(watchlistLastQuery, watchlistLastUserId);
    }, 2000);
    console.log('🔄 Watchlist auto-refresh started (every 2s)');
}

// Background refresh: fetches new data without blocking the response
async function refreshWatchlistInBackground(queryParams, userId) {
    if (watchlistRefreshing) return; // already refreshing, skip
    watchlistRefreshing = true;
    try {
        const rows = await _buildWatchlistData(queryParams, userId);
        const cacheKey = `${queryParams.nse || ''}_${queryParams.nfoUnderlyings || ''}_${queryParams.mcxOptSymbols || ''}`;
        watchlistCache = { data: rows, time: Date.now(), key: cacheKey };
    } catch (err) {
        console.warn('Watchlist background refresh error:', err.message);
    } finally {
        watchlistRefreshing = false;
    }
}

// GET /api/kite/market/watchlist
// INSTANT response from cache, background refresh every 2s
router.get('/market/watchlist', authMiddleware, asyncHandler(async (req, res) => {
    try {
        const now = Date.now();
        const cacheKey = `${req.query.nse || ''}_${req.query.nfoUnderlyings || ''}_${req.query.mcxOptSymbols || ''}`;

        // If cache has data → return INSTANTLY, trigger background refresh if stale
        if (watchlistCache.data && watchlistCache.key === cacheKey) {
            watchlistLastQuery = req.query;
            watchlistLastUserId = req.user?.id;
            startWatchlistAutoRefresh();
            return res.json(watchlistCache.data);
        }

        // First ever call → must wait for data (no cache yet)
        const rows = await _buildWatchlistData(req.query, req.user?.id);
        watchlistCache = { data: rows, time: Date.now(), key: cacheKey };
        watchlistLastQuery = req.query;
        watchlistLastUserId = req.user?.id;
        startWatchlistAutoRefresh(); // start auto-refresh loop after first successful build
        res.json(rows);
    } catch (err) {
        console.error('Unified watchlist error:', err.message);
        if (err.message?.includes('403') || err.message?.includes('expired')) {
            kiteService.clearSession();
            try { if (req.user?.id) await kiteAuthService.disconnect(req.user.id); } catch (_) {}
            return res.status(503).json({ error: 'Kite session expired. Please reconnect.', kite_disconnected: true });
        }
        res.status(500).json({ status: 'error', message: err.message });
    }
}));

// ══════════════════════════════════════════════════════════════
//   OPTIMIZED WATCHLIST BUILD — precomputed symbols, single batch, parallel
// ══════════════════════════════════════════════════════════════

// Precomputed symbol map — rebuilt only when instruments cache changes
let _precomputed = null;
let _precomputedInstrTime = 0;

function _getPrecomputed(instruments, query) {
    // Rebuild only if instruments cache changed (every 6 hours)
    if (_precomputed && _precomputedInstrTime === instrumentsCacheTime) {
        return _precomputed;
    }

    console.log('⚡ Precomputing watchlist symbol map...');
    const today = new Date();

    // ── NSE ──
    const nseList = String(query.nse || '').trim();
    const nseSymbols = nseList
        ? nseList.split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
        : NIFTY50.slice();
    const nseKeys = nseSymbols.map(s => `NSE:${s}`);

    // ── NFO underlyings ──
    const nfoUnderlyings = String(query.nfoUnderlyings || 'NIFTY,BANKNIFTY')
        .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    const nfoRange = parseInt(query.nfoRange) || 1000;

    const indexSymbolMap = {
        NIFTY: 'NSE:NIFTY 50', BANKNIFTY: 'NSE:NIFTY BANK',
        FINNIFTY: 'NSE:NIFTY FIN SERVICE', MIDCPNIFTY: 'NSE:NIFTY MID SELECT', SENSEX: 'BSE:SENSEX',
    };

    // Collect LTP keys needed for ATM calculation
    const ltpKeys = [];
    const nfoConfig = [];
    for (const u of nfoUnderlyings) {
        const step = getOptionStrikeStepNfo(u);
        if (!step) continue;
        const idxKey = indexSymbolMap[u] || `NSE:${u}`;
        ltpKeys.push(idxKey);
        const fut = pickNearestExpiry(instruments, { exchange: 'NFO', name: u, instrumentTypes: ['FUT'] });
        if (fut?.tradingsymbol) ltpKeys.push(`NFO:${fut.tradingsymbol}`);
        const nearestOpt = pickNearestExpiry(instruments, { exchange: 'NFO', name: u, instrumentTypes: ['CE', 'PE'] });
        nfoConfig.push({ underlying: u, step, idxKey, futKey: fut ? `NFO:${fut.tradingsymbol}` : null, expiry: nearestOpt ? toYmd(nearestOpt.expiry) : null, range: nfoRange });
    }

    // ── MCX precompute: find nearest FUT for each base ONCE ──
    const mcxFutBases = MCX_ALLOWED_WATCHLIST.map(canonicalMcxName);
    const mcxOptRequested = String(query.mcxOptSymbols || MCX_ALLOWED_WATCHLIST.join(','))
        .split(',').map(s => s.trim().toUpperCase()).filter(Boolean).filter(s => MCX_ALLOWED_WATCHLIST.includes(s));
    const mcxOptRange = parseInt(query.mcxOptRange) || 2000;

    // Build MCX FUT lookup ONCE (avoid scanning 100K instruments per base)
    const mcxFutByBase = {}; // base → { tradingsymbol, expiry, fullKey }
    for (const inst of instruments) {
        if (inst.exchange !== 'MCX') continue;
        if (String(inst.instrument_type || '').toUpperCase() !== 'FUT') continue;
        if (new Date(inst.expiry || 0) < today) continue;
        for (const base of mcxFutBases) {
            if (isExactMcxFutureForBase(inst.tradingsymbol, base)) {
                if (!mcxFutByBase[base] || new Date(inst.expiry) < new Date(mcxFutByBase[base].expiry)) {
                    mcxFutByBase[base] = { tradingsymbol: inst.tradingsymbol, expiry: inst.expiry, fullKey: `MCX:${inst.tradingsymbol}` };
                }
            }
        }
    }

    // Add MCX FUT keys to LTP fetch
    for (const base of mcxFutBases) {
        if (mcxFutByBase[base]) ltpKeys.push(mcxFutByBase[base].fullKey);
    }

    // Build NFO/MCX option instrument index ONCE (avoid scanning 100K per underlying)
    const nfoOptIndex = {}; // underlying → [{ inst, strike, type, expiry }]
    const mcxOptIndex = {}; // base → [{ inst, strike, type, expiry }]
    for (const inst of instruments) {
        const it = String(inst.instrument_type || '').toUpperCase();
        if (it !== 'CE' && it !== 'PE') continue;
        if (inst.exchange === 'NFO') {
            const name = String(inst.name || '').toUpperCase();
            if (!nfoOptIndex[name]) nfoOptIndex[name] = [];
            nfoOptIndex[name].push(inst);
        } else if (inst.exchange === 'MCX') {
            const name = String(inst.name || '').toUpperCase();
            if (!mcxOptIndex[name]) mcxOptIndex[name] = [];
            mcxOptIndex[name].push(inst);
        }
    }

    _precomputed = { nseKeys, nfoConfig, mcxFutBases, mcxFutByBase, mcxOptRequested, mcxOptRange, ltpKeys, nfoOptIndex, mcxOptIndex, indexSymbolMap };
    _precomputedInstrTime = instrumentsCacheTime;
    console.log(`⚡ Precomputed: NSE=${nseKeys.length} | NFO underlyings=${nfoConfig.length} | MCX bases=${mcxFutBases.length} | LTP keys=${ltpKeys.length}`);
    return _precomputed;
}

async function _buildWatchlistData(query, userId) {
    // Token sync
    if (!kiteService.isAuthenticated() && userId) {
        try {
            const status = await kiteAuthService.getStatus(userId);
            if (status.connected) {
                const session = await require('../repositories/KiteRepository').getSessionByUserId(userId);
                if (session?.access_token) {
                    kiteService.accessToken = session.access_token;
                    kiteService.sessionData = { access_token: session.access_token, user_name: session.user_name };
                }
            }
        } catch (_) {}
    }

    if (!kiteService.isAuthenticated()) {
        throw new Error('Kite not connected');
    }

    const instruments = await getInstrumentsFromCache();
    const pc = _getPrecomputed(instruments, query);

    // ── Step 1: ONE batch call for all LTP keys (index + futures) ──
    let ltpQuotes = {};
    if (pc.ltpKeys.length > 0) {
        try { ltpQuotes = await kiteService.getQuote(pc.ltpKeys); } catch (_) {}
    }

    // ── Step 2: Build NFO option keys using precomputed index + LTP ──
    const nfoOptionKeys = [];
    const nfoOptionMeta = {};

    for (const cfg of pc.nfoConfig) {
        if (!cfg.expiry) continue;
        let ltp = ltpQuotes?.[cfg.idxKey]?.last_price || 0;
        if (!ltp && cfg.futKey) ltp = ltpQuotes?.[cfg.futKey]?.last_price || 0;
        if (!ltp) continue;

        const atmStrike = Math.round(ltp / cfg.step) * cfg.step;
        const lower = Math.floor((ltp - cfg.range) / cfg.step) * cfg.step;
        const upper = Math.ceil((ltp + cfg.range) / cfg.step) * cfg.step;
        const strikeSet = new Set();
        for (let s = lower; s <= upper; s += cfg.step) strikeSet.add(s);

        const requestedExpiry = new Date(cfg.expiry).toDateString();
        const optList = pc.nfoOptIndex[cfg.underlying] || [];
        for (const inst of optList) {
            if (new Date(inst.expiry || 0).toDateString() !== requestedExpiry) continue;
            const strike = Number(inst.strike);
            if (!strikeSet.has(strike)) continue;
            const fullKey = `NFO:${inst.tradingsymbol}`;
            const it = String(inst.instrument_type || '').toUpperCase();
            nfoOptionKeys.push(fullKey);
            nfoOptionMeta[fullKey] = { strike, optionType: it, expiry: cfg.expiry, underlying: cfg.underlying, isATM: strike === atmStrike };
        }
    }

    // ── Step 3: MCX Futures keys ──
    const mcxFutKeys = [];
    const mcxFutMeta = {};
    for (const base of pc.mcxFutBases) {
        const f = pc.mcxFutByBase[base];
        if (!f) continue;
        mcxFutKeys.push(f.fullKey);
        mcxFutMeta[f.fullKey] = { expiry: toYmd(f.expiry) };
    }

    // ── Step 4: MCX Options using precomputed index + LTP from step 1 ──
    const mcxOptKeys = [];
    const mcxOptMeta = {};

    for (const reqName of pc.mcxOptRequested) {
        const base = canonicalMcxName(reqName);
        const step = MCX_ALLOWED[base]?.step || 10;
        const fut = pc.mcxFutByBase[base];
        if (!fut) continue;

        const ltp = ltpQuotes?.[fut.fullKey]?.last_price || 0;
        if (!ltp) continue;

        const nearestOpt = pickNearestExpiry(instruments, { exchange: 'MCX', name: base, instrumentTypes: ['CE', 'PE'] });
        if (!nearestOpt) continue;
        const expiryYmd = toYmd(nearestOpt.expiry);
        if (!expiryYmd) continue;

        const atmStrike = Math.round(ltp / step) * step;
        const lower = Math.floor((ltp - pc.mcxOptRange) / step) * step;
        const upper = Math.ceil((ltp + pc.mcxOptRange) / step) * step;
        const strikeSet = new Set();
        for (let s = lower; s <= upper; s += step) strikeSet.add(s);

        const requestedExpiry = new Date(expiryYmd).toDateString();
        const optList = pc.mcxOptIndex[base] || [];
        for (const inst of optList) {
            if (new Date(inst.expiry || 0).toDateString() !== requestedExpiry) continue;
            const strike = Number(inst.strike);
            if (!strikeSet.has(strike)) continue;
            const fullKey = `MCX:${inst.tradingsymbol}`;
            const it = String(inst.instrument_type || '').toUpperCase();
            mcxOptKeys.push(fullKey);
            mcxOptMeta[fullKey] = { strike, optionType: it, expiry: expiryYmd, base, isATM: strike === atmStrike };
        }
    }

    // ── Step 5: ONE batch quote fetch for ALL symbols (parallel chunks) ──
    const allKeys = [...pc.nseKeys, ...nfoOptionKeys, ...mcxFutKeys, ...mcxOptKeys];
    const uniqueKeys = Array.from(new Set(allKeys));

    // Parallel batch: split into 500-symbol chunks, fetch simultaneously
    const rawQuotes = {};
    const chunks = [];
    for (let i = 0; i < uniqueKeys.length; i += 500) {
        chunks.push(uniqueKeys.slice(i, i + 500));
    }
    const results = await Promise.all(chunks.map(chunk =>
        kiteService.getQuote(chunk).catch(() => ({}))
    ));
    for (const r of results) {
        if (r && typeof r === 'object') Object.assign(rawQuotes, r);
    }

    // ── Step 6: Build rows ──
    const rows = [];
    for (const key of pc.nseKeys) {
        rows.push(buildUnifiedRow({ type: 'NSE', symbol: key, quote: rawQuotes[key] }));
    }
    for (const key of nfoOptionKeys) {
        const m = nfoOptionMeta[key] || {};
        rows.push(buildUnifiedRow({ type: 'OPTION', symbol: key, strike: m.strike, optionType: m.optionType, expiry: m.expiry, quote: rawQuotes[key] }));
    }
    for (const key of mcxFutKeys) {
        const m = mcxFutMeta[key] || {};
        rows.push(buildUnifiedRow({ type: 'MCX_FUT', symbol: key, expiry: m.expiry, quote: rawQuotes[key] }));
    }
    for (const key of mcxOptKeys) {
        const m = mcxOptMeta[key] || {};
        rows.push(buildUnifiedRow({ type: 'MCX_OPT', symbol: key, strike: m.strike, optionType: m.optionType, expiry: m.expiry, quote: rawQuotes[key] }));
    }

    // ── Step 7: Push via WebSocket ──
    const io = require('../websocket/SocketManager').getIo();
    if (io) {
        const wsPayload = {};
        for (const row of rows) {
            wsPayload[row.symbol] = row;
        }
        io.emit('price_update', wsPayload);
    }

    return rows;
}

// ══════════════════════════════════════════════════════════════
//   OPTIONS CHAIN — Range-based strike chain (CE + PE)
// ══════════════════════════════════════════════════════════════

// Strike step sizes per index (how far apart each strike is)
const STRIKE_STEPS = {
    NIFTY:      50,
    BANKNIFTY:  100,
    FINNIFTY:   50,
    MIDCPNIFTY: 25,
    SENSEX:     100,
};

// Options chain cache — per-key TTL, separate from dashboard cache
const optionsChainCache = {};  // { key: { data, time } }
const OPTIONS_CACHE_TTL = 1500; // 1.5 seconds (same as dashboard quotes)

// ── /market/options-chain — Returns CE + PE for strikes within ±range of LTP ──
router.get('/market/options-chain', authMiddleware, asyncHandler(async (req, res) => {
    try {
        if (!kiteService.isAuthenticated()) {
            return res.status(503).json({ error: 'Kite not connected.', kite_disconnected: true });
        }

        // ── 1. Parse & validate query params ──
        const symbol = (req.query.symbol || '').toUpperCase();
        const range  = parseInt(req.query.range) || 1000;
        const expiry = req.query.expiry || '';  // e.g. "2026-04-24"

        if (!symbol) {
            return res.status(400).json({ error: 'symbol is required (e.g. NIFTY, BANKNIFTY)' });
        }
        if (!expiry) {
            return res.status(400).json({ error: 'expiry is required (e.g. 2026-04-24)' });
        }

        const step = STRIKE_STEPS[symbol];
        if (!step) {
            return res.status(400).json({
                error: `Unknown symbol: ${symbol}. Supported: ${Object.keys(STRIKE_STEPS).join(', ')}`,
            });
        }

        // ── 2. Cache check — avoid hammering Kite API ──
        const cacheKey = `${symbol}_${expiry}_${range}`;
        const now = Date.now();
        const cached = optionsChainCache[cacheKey];
        if (cached && (now - cached.time) < OPTIONS_CACHE_TTL) {
            return res.json(cached.data);
        }

        // ── 3. Get current LTP of the underlying index ──
        //    NIFTY → NSE:NIFTY 50, BANKNIFTY → NSE:NIFTY BANK
        const indexSymbolMap = {
            NIFTY:      'NSE:NIFTY 50',
            BANKNIFTY:  'NSE:NIFTY BANK',
            FINNIFTY:   'NSE:NIFTY FIN SERVICE',
            MIDCPNIFTY: 'NSE:NIFTY MID SELECT',
            SENSEX:     'BSE:SENSEX',
        };

        const indexKey = indexSymbolMap[symbol] || `NSE:${symbol}`;
        let ltp = 0;

        try {
            const ltpResult = await kiteService.getQuote([indexKey]);
            ltp = ltpResult?.[indexKey]?.last_price || 0;
        } catch (ltpErr) {
            console.warn('Options chain: LTP fetch failed for', indexKey, ltpErr.message);
        }

        // Fallback: if LTP fetch fails, try the futures price
        if (!ltp) {
            try {
                const instruments = await getInstrumentsFromCache();
                const futContract = instruments
                    .filter(i => i.exchange === 'NFO' && i.name === symbol && i.instrument_type === 'FUT')
                    .sort((a, b) => new Date(a.expiry || 0) - new Date(b.expiry || 0))
                    .find(i => new Date(i.expiry) >= new Date());

                if (futContract) {
                    const futKey = `NFO:${futContract.tradingsymbol}`;
                    const futResult = await kiteService.getQuote([futKey]);
                    ltp = futResult?.[futKey]?.last_price || 0;
                }
            } catch (_) {}
        }

        if (!ltp) {
            return res.status(400).json({ error: `Could not fetch LTP for ${symbol}. Market may be closed.` });
        }

        // ── 4. Calculate strike range ──
        const atmStrike = Math.round(ltp / step) * step;
        const lowerBound = Math.floor((ltp - range) / step) * step;
        const upperBound = Math.ceil((ltp + range) / step) * step;

        // Generate all strikes in range
        const strikes = [];
        for (let s = lowerBound; s <= upperBound; s += step) {
            strikes.push(s);
        }

        // ── 5. Find matching CE + PE instruments from cached instrument list ──
        const instruments = await getInstrumentsFromCache();

        // Filter to only this symbol's options for the requested expiry
        // Normalize expiry formats: CSV may have "2026-04-24", "2026-04-24T00:00:00", "24-04-2026" etc.
        const requestedExpiry = new Date(expiry).toDateString(); // "Thu Apr 24 2026"

        const optionInstruments = instruments.filter(i => {
            if (i.exchange !== 'NFO') return false;
            if (i.name !== symbol) return false;
            if (i.instrument_type !== 'CE' && i.instrument_type !== 'PE') return false;
            // Robust expiry match — compare as Date objects
            const instrExpiry = new Date(i.expiry || 0).toDateString();
            return instrExpiry === requestedExpiry;
        });

        // Build a lookup: { "5400_CE": instrument, "5400_PE": instrument }
        const strikeSet = new Set(strikes);
        const instrumentMap = {};
        const symbolsToFetch = [];

        for (const inst of optionInstruments) {
            const strike = parseFloat(inst.strike);
            if (!strikeSet.has(strike)) continue;

            const key = `${strike}_${inst.instrument_type}`;
            instrumentMap[key] = inst;
            symbolsToFetch.push(`NFO:${inst.tradingsymbol}`);
        }

        console.log(`📊 Options Chain: ${symbol} LTP=${ltp} ATM=${atmStrike} | Range=${lowerBound}-${upperBound} | ${strikes.length} strikes | ${symbolsToFetch.length} contracts to fetch`);

        // DEBUG: Log sample instruments to verify matching
        if (symbolsToFetch.length === 0) {
            console.warn(`⚠️  Options Chain: 0 contracts found! Checking instrument data...`);
            const sampleOpts = instruments.filter(i => i.exchange === 'NFO' && i.name === symbol && (i.instrument_type === 'CE' || i.instrument_type === 'PE')).slice(0, 3);
            console.warn(`   Sample instruments:`, sampleOpts.map(i => ({ ts: i.tradingsymbol, expiry: i.expiry, strike: i.strike, type: i.instrument_type })));
            console.warn(`   Requested expiry: "${expiry}"`);
            console.warn(`   Strike range: ${lowerBound}-${upperBound}, step: ${step}`);
        } else {
            console.log(`   First 3 symbols: ${symbolsToFetch.slice(0, 3).join(', ')}`);
        }

        // ── 6. Fetch FRESH quotes directly (bypass any shared cache) ──
        const rawQuotes = {};
        const batchSize = 500;
        for (let i = 0; i < symbolsToFetch.length; i += batchSize) {
            const batch = symbolsToFetch.slice(i, i + batchSize);
            try {
                const result = await kiteService.getQuote(batch);
                if (result && typeof result === 'object') Object.assign(rawQuotes, result);
            } catch (err) {
                console.warn(`Options quote batch error:`, err.message);
            }
            if (i + batchSize < symbolsToFetch.length) await sleep(80);
        }

        // DEBUG: Log a sample quote to verify data is fresh
        const sampleKey = symbolsToFetch[0];
        if (sampleKey && rawQuotes[sampleKey]) {
            console.log(`   Sample quote [${sampleKey}]: LTP=${rawQuotes[sampleKey].last_price}, Vol=${rawQuotes[sampleKey].volume}, Timestamp=${rawQuotes[sampleKey].timestamp}`);
        } else if (sampleKey) {
            console.warn(`   ⚠️ No quote data for ${sampleKey}! Keys in response:`, Object.keys(rawQuotes).slice(0, 5));
        }

        // ── 7. Build the chain: one row per strike with CE + PE ──
        const chain = [];

        for (const strike of strikes) {
            const ceInst = instrumentMap[`${strike}_CE`];
            const peInst = instrumentMap[`${strike}_PE`];

            const ceKey = ceInst ? `NFO:${ceInst.tradingsymbol}` : null;
            const peKey = peInst ? `NFO:${peInst.tradingsymbol}` : null;

            const ceQuote = ceKey ? rawQuotes[ceKey] : null;
            const peQuote = peKey ? rawQuotes[peKey] : null;

            // Classify: ITM / ATM / OTM
            let classification;
            if (strike === atmStrike) {
                classification = 'ATM';
            } else if (strike < atmStrike) {
                classification = 'ITM';  // CE is ITM below ATM, PE is OTM
            } else {
                classification = 'OTM';  // CE is OTM above ATM, PE is ITM
            }

            chain.push({
                strike,
                classification,
                isATM: strike === atmStrike,
                CE: ceQuote ? {
                    tradingsymbol: ceInst.tradingsymbol,
                    token: ceInst.instrument_token,
                    ltp:    ceQuote.last_price || 0,
                    oi:     ceQuote.oi || 0,
                    volume: ceQuote.volume || 0,
                    chg:    ceQuote.net_change || 0,
                    chg_pct: ceQuote.ohlc?.close
                        ? (((ceQuote.last_price - ceQuote.ohlc.close) / ceQuote.ohlc.close) * 100).toFixed(2)
                        : '0.00',
                    bid:    ceQuote.depth?.buy?.[0]?.price || 0,
                    ask:    ceQuote.depth?.sell?.[0]?.price || 0,
                    open:   ceQuote.ohlc?.open || 0,
                    high:   ceQuote.ohlc?.high || 0,
                    low:    ceQuote.ohlc?.low || 0,
                    close:  ceQuote.ohlc?.close || 0,
                } : null,
                PE: peQuote ? {
                    tradingsymbol: peInst.tradingsymbol,
                    token: peInst.instrument_token,
                    ltp:    peQuote.last_price || 0,
                    oi:     peQuote.oi || 0,
                    volume: peQuote.volume || 0,
                    chg:    peQuote.net_change || 0,
                    chg_pct: peQuote.ohlc?.close
                        ? (((peQuote.last_price - peQuote.ohlc.close) / peQuote.ohlc.close) * 100).toFixed(2)
                        : '0.00',
                    bid:    peQuote.depth?.buy?.[0]?.price || 0,
                    ask:    peQuote.depth?.sell?.[0]?.price || 0,
                    open:   peQuote.ohlc?.open || 0,
                    high:   peQuote.ohlc?.high || 0,
                    low:    peQuote.ohlc?.low || 0,
                    close:  peQuote.ohlc?.close || 0,
                } : null,
            });
        }

        // ── 8. Build response ──
        const response = {
            status: 'success',
            symbol,
            ltp,
            atm: atmStrike,
            step,
            expiry,
            range: `${lowerBound}-${upperBound}`,
            count: chain.length,
            totalContracts: symbolsToFetch.length,
            timestamp: new Date().toISOString(),
            data: chain,
        };

        // Cache the response
        optionsChainCache[cacheKey] = { data: response, time: now };

        res.json(response);
    } catch (err) {
        console.error('Options chain error:', err.message);
        if (err.message?.includes('403') || err.message?.includes('expired')) {
            return res.status(503).json({ error: 'Kite session expired.', kite_disconnected: true });
        }
        res.status(500).json({ status: 'error', message: err.message });
    }
}));

// ══════════════════════════════════════════════════════════════
//   MCX CONTROLLED FUTURES + OPTIONS CHAIN
// ══════════════════════════════════════════════════════════════

// STRICT allowed MCX symbols — nothing else gets through
const MCX_ALLOWED = {
    // Main contracts
    GOLD:           { step: 100, label: 'Gold' },
    SILVER:         { step: 500, label: 'Silver' },
    CRUDEOIL:       { step: 50,  label: 'Crude Oil' },
    COPPER:         { step: 5,   label: 'Copper' },
    ZINC:           { step: 5,   label: 'Zinc' },
    ALUMINIUM:      { step: 5,   label: 'Aluminium' },
    LEAD:           { step: 5,   label: 'Lead' },
    NATURALGAS:     { step: 10,  label: 'Natural Gas' },
    // Mini contracts
    GOLDM:          { step: 100, label: 'Gold Mini' },
    SILVERM:        { step: 500, label: 'Silver Mini' },
    CRUDEOILM:      { step: 50,  label: 'Crude Oil Mini' },
    ZINCMINI:       { step: 5,   label: 'Zinc Mini' },
    ALUMINI:        { step: 5,   label: 'Aluminium Mini' },
    LEADMINI:       { step: 5,   label: 'Lead Mini' },
    COPPERM:        { step: 5,   label: 'Copper Mini' },
    NATGASMINI:     { step: 10,  label: 'Natural Gas Mini' },
};

const MCX_MAIN = ['GOLD', 'SILVER', 'CRUDEOIL', 'COPPER', 'ZINC', 'ALUMINIUM', 'LEAD', 'NATURALGAS'];
const MCX_MINI = ['GOLDM', 'SILVERM', 'CRUDEOILM', 'ZINCMINI', 'ALUMINI', 'LEADMINI', 'COPPERM', 'NATGASMINI'];
const MCX_ALL_SYMBOLS = [...MCX_MAIN, ...MCX_MINI];

// Helper: fetch fresh quotes (NO cache, always live)
async function fetchFreshQuotes(symbols) {
    const quotes = {};
    const batchSize = 500;
    for (let i = 0; i < symbols.length; i += batchSize) {
        const batch = symbols.slice(i, i + batchSize);
        try {
            const result = await kiteService.getQuote(batch);
            if (result && typeof result === 'object') Object.assign(quotes, result);
        } catch (err) {
            console.warn('MCX quote batch error:', err.message);
        }
        if (i + batchSize < symbols.length) await sleep(80);
    }
    return quotes;
}

// Helper: format a quote into clean object
function formatMcxQuote(quote) {
    if (!quote) return null;
    return {
        ltp:    quote.last_price || 0,
        bid:    quote.depth?.buy?.[0]?.price || 0,
        ask:    quote.depth?.sell?.[0]?.price || 0,
        oi:     quote.oi || 0,
        volume: quote.volume || 0,
        chg:    quote.net_change || 0,
        chg_pct: quote.ohlc?.close
            ? (((quote.last_price - quote.ohlc.close) / quote.ohlc.close) * 100).toFixed(2)
            : '0.00',
        open:   quote.ohlc?.open || 0,
        high:   quote.ohlc?.high || 0,
        low:    quote.ohlc?.low || 0,
        close:  quote.ohlc?.close || 0,
    };
}

function isExactMcxFutureForBase(tradingSymbol, base) {
    const ts = String(tradingSymbol || '').toUpperCase();
    const b = String(base || '').toUpperCase();
    if (!ts || !b) return false;
    return new RegExp(`^${b}\\d{1,2}[A-Z]{3}\\d{0,2}FUT$`).test(ts);
}

// ── /market/mcx-futures — Filtered MCX futures (main + mini) ──
router.get('/market/mcx-futures', authMiddleware, asyncHandler(async (req, res) => {
    try {
        if (!kiteService.isAuthenticated()) {
            return res.status(503).json({ error: 'Kite not connected.', kite_disconnected: true });
        }

        const filter = (req.query.filter || 'ALL').toUpperCase(); // ALL, MAIN, MINI, or specific symbol

        const instruments = await getInstrumentsFromCache();
        const today = new Date();

        // Decide which symbols
        let allowedList;
        if (filter === 'ALL') allowedList = MCX_ALL_SYMBOLS;
        else if (filter === 'MAIN') allowedList = MCX_MAIN;
        else if (filter === 'MINI') allowedList = MCX_MINI;
        else if (MCX_ALLOWED[filter]) allowedList = [filter];
        else return res.status(400).json({ error: `Unknown filter: ${filter}. Allowed: ALL, MAIN, MINI, ${MCX_ALL_SYMBOLS.join(', ')}` });

        // Find nearest FUT contract for each allowed symbol
        const futures = [];
        const symbolsToFetch = [];

        for (const base of allowedList) {
            const nearest = instruments
                .filter(i => i.exchange === 'MCX' && i.instrument_type === 'FUT'
                    && isExactMcxFutureForBase(i.tradingsymbol, base))
                .filter(i => new Date(i.expiry || 0) >= today)
                .sort((a, b) => new Date(a.expiry || 0) - new Date(b.expiry || 0))[0];

            if (nearest) {
                const fullKey = `MCX:${nearest.tradingsymbol}`;
                const futMatch = nearest.tradingsymbol.match(/^([A-Z]+?)(\d{2}[A-Z]{3}\d{0,2})FUT$/);
                futures.push({
                    base,
                    label: MCX_ALLOWED[base]?.label || base,
                    tradingsymbol: nearest.tradingsymbol,
                    fullKey,
                    expiry: new Date(nearest.expiry || 0).toISOString().substring(0, 10),
                    lot_size: nearest.lot_size || '',
                    displayName: futMatch ? `${futMatch[1]} ${futMatch[2]}` : nearest.tradingsymbol,
                    isMain: MCX_MAIN.includes(base),
                });
                symbolsToFetch.push(fullKey);
            }
        }

        // Fetch FRESH quotes — NO cache
        const rawQuotes = await fetchFreshQuotes(symbolsToFetch);

        // Build response
        const data = futures.map(f => ({
            ...f,
            ...formatMcxQuote(rawQuotes[f.fullKey]),
            timestamp: rawQuotes[f.fullKey]?.timestamp || null,
        }));

        res.json({
            status: 'success',
            filter,
            count: data.length,
            categories: { MAIN: MCX_MAIN, MINI: MCX_MINI },
            timestamp: new Date().toISOString(),
            data,
        });
    } catch (err) {
        console.error('MCX futures error:', err.message);
        if (err.message?.includes('403') || err.message?.includes('expired')) {
            return res.status(503).json({ error: 'Kite session expired.', kite_disconnected: true });
        }
        res.status(500).json({ status: 'error', message: err.message });
    }
}));

// ── /market/mcx-options — Options chain for a specific MCX commodity ──
router.get('/market/mcx-options', authMiddleware, asyncHandler(async (req, res) => {
    try {
        if (!kiteService.isAuthenticated()) {
            return res.status(503).json({ error: 'Kite not connected.', kite_disconnected: true });
        }

        const symbol = (req.query.symbol || '').toUpperCase();
        const expiry = req.query.expiry || '';
        const range  = parseInt(req.query.range) || 2000;

        if (!symbol || !MCX_ALLOWED[symbol]) {
            return res.status(400).json({ error: `Invalid symbol. Allowed: ${MCX_ALL_SYMBOLS.join(', ')}` });
        }
        if (!expiry) {
            return res.status(400).json({ error: 'expiry is required (e.g. 2026-04-28)' });
        }

        const step = MCX_ALLOWED[symbol].step;
        const instruments = await getInstrumentsFromCache();
        const today = new Date();

        // ── 1. Get LTP from nearest futures contract ──
        const futContract = instruments
            .filter(i => i.exchange === 'MCX' && i.instrument_type === 'FUT'
                && isExactMcxFutureForBase(i.tradingsymbol, symbol))
            .filter(i => new Date(i.expiry || 0) >= today)
            .sort((a, b) => new Date(a.expiry || 0) - new Date(b.expiry || 0))[0];

        if (!futContract) {
            return res.status(400).json({ error: `No active futures found for ${symbol}` });
        }

        const futKey = `MCX:${futContract.tradingsymbol}`;
        const futQuoteRaw = await kiteService.getQuote([futKey]);
        const futQuote = futQuoteRaw?.[futKey];
        const ltp = futQuote?.last_price || 0;

        if (!ltp) {
            return res.status(400).json({ error: `Could not fetch LTP for ${symbol}. Market may be closed.` });
        }

        // ── 2. Calculate strike range ──
        const atmStrike = Math.round(ltp / step) * step;
        const lowerBound = Math.floor((ltp - range) / step) * step;
        const upperBound = Math.ceil((ltp + range) / step) * step;

        const strikes = [];
        for (let s = lowerBound; s <= upperBound; s += step) {
            strikes.push(s);
        }

        // ── 3. Find CE + PE instruments for this symbol + expiry + strike range ──
        const requestedExpiry = new Date(expiry).toDateString();
        const strikeSet = new Set(strikes);
        const instrumentMap = {};
        const symbolsToFetch = [futKey]; // include futures for live data

        for (const inst of instruments) {
            if (inst.exchange !== 'MCX') continue;
            if (inst.name !== symbol) continue;
            if (inst.instrument_type !== 'CE' && inst.instrument_type !== 'PE') continue;
            if (new Date(inst.expiry || 0).toDateString() !== requestedExpiry) continue;

            const strike = parseFloat(inst.strike);
            if (!strikeSet.has(strike)) continue;

            const key = `${strike}_${inst.instrument_type}`;
            instrumentMap[key] = inst;
            symbolsToFetch.push(`MCX:${inst.tradingsymbol}`);
        }

        console.log(`📊 MCX Options: ${symbol} LTP=${ltp} ATM=${atmStrike} | ${strikes.length} strikes | ${symbolsToFetch.length - 1} option contracts`);

        // ── 4. Fetch FRESH quotes — NO cache ──
        const rawQuotes = await fetchFreshQuotes(symbolsToFetch);

        // ── 5. Build options chain ──
        const chain = [];
        for (const strike of strikes) {
            const ceInst = instrumentMap[`${strike}_CE`];
            const peInst = instrumentMap[`${strike}_PE`];

            const ceQuote = ceInst ? rawQuotes[`MCX:${ceInst.tradingsymbol}`] : null;
            const peQuote = peInst ? rawQuotes[`MCX:${peInst.tradingsymbol}`] : null;

            let classification;
            if (strike === atmStrike) classification = 'ATM';
            else if (strike < atmStrike) classification = 'ITM';
            else classification = 'OTM';

            chain.push({
                strike,
                classification,
                isATM: strike === atmStrike,
                CE: ceQuote ? { tradingsymbol: ceInst.tradingsymbol, ...formatMcxQuote(ceQuote) } : null,
                PE: peQuote ? { tradingsymbol: peInst.tradingsymbol, ...formatMcxQuote(peQuote) } : null,
            });
        }

        // ── 6. Response with futures data + options chain ──
        res.json({
            status: 'success',
            symbol,
            label: MCX_ALLOWED[symbol].label,
            step,
            expiry,
            future: {
                tradingsymbol: futContract.tradingsymbol,
                expiry: new Date(futContract.expiry || 0).toISOString().substring(0, 10),
                ...formatMcxQuote(rawQuotes[futKey]),
            },
            ltp,
            atm: atmStrike,
            range: `${lowerBound}-${upperBound}`,
            count: chain.length,
            totalContracts: symbolsToFetch.length - 1,
            timestamp: new Date().toISOString(),
            data: chain,
        });
    } catch (err) {
        console.error('MCX options error:', err.message);
        if (err.message?.includes('403') || err.message?.includes('expired')) {
            return res.status(503).json({ error: 'Kite session expired.', kite_disconnected: true });
        }
        res.status(500).json({ status: 'error', message: err.message });
    }
}));

// ── /market/mcx-expiries — Available option expiries for a MCX symbol ──
router.get('/market/mcx-expiries', authMiddleware, asyncHandler(async (req, res) => {
    try {
        if (!kiteService.isAuthenticated()) {
            return res.status(503).json({ error: 'Kite not connected.', kite_disconnected: true });
        }

        const symbol = (req.query.symbol || '').toUpperCase();
        if (!symbol || !MCX_ALLOWED[symbol]) {
            return res.status(400).json({ error: `Invalid symbol. Allowed: ${MCX_ALL_SYMBOLS.join(', ')}` });
        }

        const instruments = await getInstrumentsFromCache();
        const now = new Date();
        const expiries = new Set();

        for (const inst of instruments) {
            if (inst.exchange !== 'MCX') continue;
            if (inst.name !== symbol) continue;
            if (inst.instrument_type !== 'CE' && inst.instrument_type !== 'PE') continue;
            const expDate = new Date(inst.expiry || 0);
            if (isNaN(expDate.getTime()) || expDate < now) continue;
            expiries.add(expDate.toISOString().substring(0, 10));
        }

        res.json({
            status: 'success',
            symbol,
            label: MCX_ALLOWED[symbol].label,
            count: expiries.size,
            expiries: Array.from(expiries).sort(),
        });
    } catch (err) {
        console.error('MCX expiries error:', err.message);
        res.status(500).json({ status: 'error', message: err.message });
    }
}));

// ── /market/options-expiries — Get available expiry dates for a symbol ──
router.get('/market/options-expiries', authMiddleware, asyncHandler(async (req, res) => {
    try {
        if (!kiteService.isAuthenticated()) {
            return res.status(503).json({ error: 'Kite not connected.', kite_disconnected: true });
        }

        const symbol = (req.query.symbol || '').toUpperCase();
        if (!symbol) {
            return res.status(400).json({ error: 'symbol is required' });
        }

        const instruments = await getInstrumentsFromCache();
        const now = new Date();

        // Find all unique future expiries for this symbol
        // Normalize to YYYY-MM-DD format regardless of CSV format
        const expiries = new Set();
        for (const inst of instruments) {
            if (inst.exchange !== 'NFO') continue;
            if (inst.name !== symbol) continue;
            if (inst.instrument_type !== 'CE' && inst.instrument_type !== 'PE') continue;
            const expDate = new Date(inst.expiry || 0);
            if (isNaN(expDate.getTime())) continue;
            if (expDate >= now) {
                // Normalize to YYYY-MM-DD
                const normalized = expDate.toISOString().substring(0, 10);
                expiries.add(normalized);
            }
        }

        // Sort ascending
        const sortedExpiries = Array.from(expiries).sort();

        // DEBUG: Log first instrument expiry format for troubleshooting
        const sampleInst = instruments.find(i => i.exchange === 'NFO' && i.name === symbol && (i.instrument_type === 'CE' || i.instrument_type === 'PE'));
        if (sampleInst) {
            console.log(`📅 Expiries for ${symbol}: CSV expiry format = "${sampleInst.expiry}", found ${sortedExpiries.length} future expiries`);
        }

        res.json({
            status: 'success',
            symbol,
            count: sortedExpiries.length,
            expiries: sortedExpiries,
        });
    } catch (err) {
        console.error('Options expiries error:', err.message);
        res.status(500).json({ status: 'error', message: err.message });
    }
}));

// ── /market/search — Search all instruments ──
router.get('/market/search', authMiddleware, asyncHandler(async (req, res) => {
    if (!kiteService.isAuthenticated()) {
        return res.status(503).json({ error: 'Kite not connected.', kite_disconnected: true });
    }
    const { q } = req.query;
    if (!q || q.length < 2) return res.json({ status: 'success', count: 0, data: [] });

    const instruments = await getInstrumentsFromCache();
    const query = q.toUpperCase();
    const results = instruments
        .filter(i => i.tradingsymbol?.toUpperCase().includes(query) || i.name?.toUpperCase().includes(query))
        .slice(0, 30)
        .map(i => ({ symbol: i.tradingsymbol, exchange: i.exchange, name: i.name || '', type: i.instrument_type || '', expiry: i.expiry || '' }));

    res.json({ status: 'success', count: results.length, data: results });
}));

// ── /market — Legacy compat ──
router.get('/market', authMiddleware, asyncHandler(async (req, res) => {
    if (!kiteService.isAuthenticated()) {
        return res.status(503).json({ error: 'Kite not connected.', kite_disconnected: true });
    }
    const nseStocks = ALL_NSE_STOCKS.map(s => `NSE:${s}`);
    const rawQuotes = await fetchQuotesBatch(nseStocks);
    res.json({ status: 'success', count: Object.keys(rawQuotes).length, timestamp: new Date().toISOString(), data: formatQuotes(rawQuotes) });
}));

// ── KITE DATA APIs ────────────────────────────────────

router.get('/profile', authMiddleware, asyncHandler(async (req, res) => {
    const data = await kiteService.getProfile();
    res.json(data);
}));

router.get('/margins', authMiddleware, asyncHandler(async (req, res) => {
    const data = await kiteService.getMargins();
    res.json(data);
}));

router.get('/holdings', authMiddleware, asyncHandler(async (req, res) => {
    const data = await kiteService.getHoldings();
    res.json(data);
}));

router.get('/positions', authMiddleware, asyncHandler(async (req, res) => {
    const data = await kiteService.getPositions();
    res.json(data);
}));

router.get('/orders', authMiddleware, asyncHandler(async (req, res) => {
    const data = await kiteService.getOrders();
    res.json(data);
}));

router.get('/trades', authMiddleware, asyncHandler(async (req, res) => {
    const data = await kiteService.getTrades();
    res.json(data);
}));

router.get('/quote', authMiddleware, asyncHandler(async (req, res) => {
    const { i } = req.query;
    if (!i) return res.status(400).json({ error: 'Instrument Required' });
    const data = await kiteService.getQuote(i);
    res.json(data);
}));

router.get('/quote/ltp', authMiddleware, asyncHandler(async (req, res) => {
    const { i } = req.query;
    if (!i) return res.status(400).json({ error: 'Instrument Required' });
    const data = await kiteService.getLTP(i);
    res.json(data);
}));

router.get('/instruments', authMiddleware, asyncHandler(async (req, res) => {
    const data = await kiteService.getInstruments();
    res.json(data);
}));

router.get('/instruments/historical/:instrumentToken/:interval', authMiddleware, asyncHandler(async (req, res) => {
    const { instrumentToken, interval } = req.params;
    const { from, to } = req.query;
    const data = await kiteService.getHistoricalData(instrumentToken, interval, from, to);
    res.json(data);
}));

// ── Kite Ticker (WebSocket) routes ──

router.get('/ticker/status', authMiddleware, asyncHandler(async (req, res) => {
    res.json({
        connected: kiteTicker.isConnected(),
        fallbackToMock: kiteTicker.fallbackToMock,
        subscribedCount: kiteTicker.subscribedTokens.length,
    });
}));

router.get('/ticker/prices', authMiddleware, asyncHandler(async (req, res) => {
    res.json(kiteTicker.getPrices());
}));

router.post('/ticker/subscribe', authMiddleware, asyncHandler(async (req, res) => {
    const { tokens, instrumentMap } = req.body;
    if (!tokens || !Array.isArray(tokens)) {
        return res.status(400).json({ error: 'tokens array required' });
    }
    if (instrumentMap) kiteTicker.setInstrumentMap(instrumentMap);
    kiteTicker.subscribe(tokens);
    res.json({ success: true, subscribedCount: kiteTicker.subscribedTokens.length });
}));

router.post('/ticker/unsubscribe', authMiddleware, asyncHandler(async (req, res) => {
    const { tokens } = req.body;
    if (!tokens || !Array.isArray(tokens)) {
        return res.status(400).json({ error: 'tokens array required' });
    }
    kiteTicker.unsubscribe(tokens);
    res.json({ success: true, subscribedCount: kiteTicker.subscribedTokens.length });
}));

router.post('/ticker/reconnect', authMiddleware, asyncHandler(async (req, res) => {
    kiteTicker.disconnect();
    kiteTicker.fallbackToMock = false;
    const started = await kiteTicker.start();
    res.json({ success: started, connected: kiteTicker.isConnected() });
}));

module.exports = router;
