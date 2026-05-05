const db = require('../config/db');
const kiteService = require('../utils/kiteService');

// Cache for Kite instruments (so we don't fetch every time)
let kiteScripCache = null;
let kiteScripCacheTime = 0;
const CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours

const getAllScrips = async (req, res) => {
    try {
        // 1. Get DB scrips (for lot_size, margin_req, status overrides)
        const [dbRows] = await db.execute('SELECT * FROM scrip_data');
        const dbMap = {};
        for (const row of dbRows) dbMap[row.symbol] = row;

        // 2. Try to get Kite instruments (dynamic, all symbols)
        let kiteSymbols = [];
        try {
            const now = Date.now();
            if (kiteScripCache && (now - kiteScripCacheTime) < CACHE_TTL) {
                kiteSymbols = kiteScripCache;
            } else if (kiteService.isAuthenticated()) {
                const instruments = await kiteService.getInstruments();
                // Pick unique tradingsymbols for NSE EQ + MCX FUT + NFO FUT
                const seen = new Set();
                kiteSymbols = instruments
                    .filter(i => {
                        if (i.exchange === 'NSE' && i.instrument_type === 'EQ') return true;
                        if (i.exchange === 'MCX' && i.instrument_type === 'FUT') return true;
                        if (i.exchange === 'NFO' && i.instrument_type === 'FUT') return true;
                        return false;
                    })
                    .map(i => {
                        // NSE EQ: use tradingsymbol (RELIANCE, TCS)
                        // MCX/NFO FUT: use name field (GOLD, SILVER, NIFTY) — strip expiry+FUT
                        const isEQ = i.instrument_type === 'EQ';
                        const cleanSymbol = isEQ ? i.tradingsymbol : (i.name || i.tradingsymbol);
                        return {
                            symbol: cleanSymbol,
                            name: i.name || i.tradingsymbol,
                            exchange: i.exchange,
                            instrument_type: i.instrument_type,
                            lot_size: parseInt(i.lot_size) || 1,
                        };
                    })
                    .filter(i => {
                        // Deduplicate by exchange:symbol
                        const key = `${i.exchange}:${i.symbol}`;
                        if (seen.has(key)) return false;
                        seen.add(key);
                        return true;
                    });
                kiteScripCache = kiteSymbols;
                kiteScripCacheTime = now;
            }
        } catch (kiteErr) {
        }

        // 3. Merge: Kite data + DB overrides
        if (kiteSymbols.length > 0) {
            const result = kiteSymbols.map(k => {
                const dbOverride = dbMap[k.symbol];
                return {
                    symbol: k.symbol,
                    name: k.name,
                    exchange: k.exchange,
                    lot_size: dbOverride?.lot_size || k.lot_size,
                    margin_req: dbOverride?.margin_req || 50,
                    market_type: k.exchange === 'MCX' ? 'MCX' : k.exchange === 'NFO' ? 'NFO' : 'EQUITY',
                    status: dbOverride?.status || 'OPEN',
                };
            });
            return res.json(result);
        }

        // 4. Fallback: DB only (if Kite not connected)
        res.json(dbRows);
    } catch (err) {
        res.status(500).send('Server Error');
    }
};

const MCX_LOT_SIZES = {
    'GOLD': 100, 'GOLDM': 10, 'GOLDPETAL': 1, 'GOLDGUINEA': 8,
    'SILVER': 30, 'SILVERM': 5, 'SILVERMIC': 1,
    'CRUDEOIL': 100, 'CRUDEOILM': 10,
    'NATURALGAS': 1250, 'NATGASMINI': 250,
    'COPPER': 2500, 'COPPERM': 500,
    'ZINC': 5000, 'ZINCMINI': 1000,
    'LEAD': 5000, 'LEADMINI': 1000,
    'NICKEL': 1500, 'NICKELMINI': 100,
    'ALUMINIUM': 5000, 'ALUMINI': 1000,
    'MENTHAOIL': 360, 'COTTON': 25, 'COTTONCNDY': 20, 'BULLDE X': 1
};

const NFO_LOT_SIZES = {
    'NIFTY': 50, 'BANKNIFTY': 50, 'FINNIFTY': 50, 'MIDCPNIFTY': 50, 'SENSEX': 10
};

const syncKiteInstruments = async (req, res) => {
    try {
        if (!kiteService.isAuthenticated()) {
            return res.status(400).json({ error: 'Kite not connected. Please authenticate first.' });
        }

        const instruments = await kiteService.getInstruments();

        if (!Array.isArray(instruments) || instruments.length === 0) {
            return res.status(400).json({ error: 'No instruments received from Kite API' });
        }

        // Filter and normalize instruments
        const seen = new Set();
        const toSync = instruments
            .filter(i => {
                if (i.exchange === 'NSE' && i.instrument_type === 'EQ') return true;
                if (i.exchange === 'MCX' && i.instrument_type === 'FUT') return true;
                if (i.exchange === 'NFO' && i.instrument_type === 'FUT') return true;
                return false;
            })
            .map(i => {
                const isEQ = i.instrument_type === 'EQ';
                const symbol = isEQ ? i.tradingsymbol : (i.name || i.tradingsymbol);
                const exchange = i.exchange;
                const marketType = exchange === 'MCX' ? 'MCX' : exchange === 'NFO' ? 'NFO' : 'EQUITY';

                // Get lot_size from hardcoded map for MCX/NFO, use 1 for NSE
                let lotSize = 1;
                if (exchange === 'MCX') {
                    lotSize = MCX_LOT_SIZES[symbol] || parseInt(i.lot_size) || 1;
                } else if (exchange === 'NFO') {
                    lotSize = NFO_LOT_SIZES[symbol] || parseInt(i.lot_size) || 1;
                }

                return { symbol, lot_size: lotSize, exchange, market_type: marketType };
            })
            .filter(i => {
                const key = `${i.exchange}:${i.symbol}`;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });

        // Upsert into scrip_data table
        let syncCount = 0;
        for (const item of toSync) {
            try {
                await db.execute(
                    `INSERT INTO scrip_data (symbol, lot_size, margin_req, market_type)
                     VALUES (?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE lot_size = VALUES(lot_size), market_type = VALUES(market_type)`,
                    [item.symbol, item.lot_size, 50, item.market_type]
                );
                syncCount++;
            } catch (err) {
            }
        }

        res.json({
            success: true,
            message: `Successfully synced ${syncCount} instruments`,
            count: syncCount
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

const updateScrip = async (req, res) => {
    const { symbol, lot_size, margin_req, status } = req.body;
    try {
        await db.execute(
            'UPDATE scrip_data SET lot_size = ?, margin_req = ?, status = ? WHERE symbol = ?',
            [lot_size, margin_req, status, symbol]
        );
        res.json({ message: 'Scrip updated' });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
};

const getTickers = async (req, res) => {
    try {
        const userId = req.user.id;

        // If ?all=true (admin panel), return only user's created tickers
        if (req.query.all === 'true') {
            // All users see only tickers they created
            const query = 'SELECT * FROM tickers WHERE created_by = ? ORDER BY id DESC';
            const params = [userId];

            const [rows] = await db.execute(query, params);
            return res.json(rows);
        }

        // For public view, only active tickers within schedule
        const [rows] = await db.execute(
            `SELECT * FROM tickers
             WHERE is_active = 1
               AND (start_time IS NULL OR start_time <= NOW())
               AND (end_time IS NULL OR end_time >= NOW())
             ORDER BY id DESC`
        );
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
};

const createTicker = async (req, res) => {
    const { text, start_time, end_time } = req.body;
    const userId = req.user.id;
    try {
        await db.execute(
            'INSERT INTO tickers (text, start_time, end_time, is_active, created_by) VALUES (?, ?, ?, ?, ?)',
            [text, start_time, end_time, 1, userId]
        );
        res.json({ message: 'Ticker created successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
};

const updateTicker = async (req, res) => {
    const { text, speed, is_active, start_time, end_time } = req.body;
    try {
        await db.execute(
            'UPDATE tickers SET text = ?, speed = ?, is_active = ?, start_time = ?, end_time = ? WHERE id = ?',
            [text, speed || 10, is_active ?? 1, start_time, end_time, req.params.id]
        );
        res.json({ message: 'Ticker updated' });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
};

const deleteTicker = async (req, res) => {
    try {
        await db.execute('DELETE FROM tickers WHERE id = ?', [req.params.id]);
        res.json({ message: 'Ticker deleted successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
};

module.exports = { getAllScrips, syncKiteInstruments, updateScrip, getTickers, createTicker, updateTicker, deleteTicker };