const db = require('../config/db');

const getLedger = async (req, res) => {
    try {
        const { userId, type } = req.query; // type: CREDIT/DEBIT
        let query = 'SELECT * FROM internal_transfers';
        const params = [];

        if (userId) {
            query += ' WHERE to_user_id = ? OR from_user_id = ?';
            params.push(userId, userId);
        }

        const [rows] = await db.execute(query, params);
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
};

const internalTransfer = async (req, res) => {
    const { toUserId, amount, notes } = req.body;
    const fromUserId = req.user.id;
    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();

        // Check balance of sender if not SUPERADMIN
        if (req.user.role !== 'SUPERADMIN') {
            const [sender] = await connection.execute('SELECT balance FROM users WHERE id = ?', [fromUserId]);
            if (sender[0].balance < amount) throw new Error('Insufficient balance');
        }

        // Update balances
        await connection.execute('UPDATE users SET balance = balance - ? WHERE id = ?', [amount, fromUserId]);
        await connection.execute('UPDATE users SET balance = balance + ? WHERE id = ?', [amount, toUserId]);

        // Log transfer
        await connection.execute(
            'INSERT INTO internal_transfers (from_user_id, to_user_id, amount, notes) VALUES (?, ?, ?, ?)',
            [fromUserId, toUserId, amount, notes]
        );

        await connection.commit();
        res.json({ message: 'Transfer successful' });
    } catch (err) {
        await connection.rollback();
        res.status(400).json({ message: err.message });
    } finally {
        connection.release();
    }
};

// GET /portfolio/balance — real balance, margin, P/L for logged-in user
const getBalance = async (req, res) => {
    try {
        const userId = req.user.id;

        // 1. User balance from DB
        const [userRows] = await db.execute('SELECT balance, credit_limit FROM users WHERE id = ?', [userId]);
        if (!userRows.length) return res.status(404).json({ message: 'User not found' });
        const balance = parseFloat(userRows[0].balance);

        // 2. Total margin used from OPEN trades
        const [marginRows] = await db.execute(
            'SELECT IFNULL(SUM(margin_used), 0) as total_margin FROM trades WHERE user_id = ? AND status = "OPEN"',
            [userId]
        );
        const totalMarginUsed = parseFloat(marginRows[0].total_margin);

        // 3. Margin breakdown by market_type
        const [segmentRows] = await db.execute(
            `SELECT market_type, IFNULL(SUM(margin_used), 0) as segment_margin
             FROM trades WHERE user_id = ? AND status = 'OPEN'
             GROUP BY market_type`,
            [userId]
        );
        const marginBySegment = { MCX: 0, EQUITY: 0, OPTIONS: 0, COMEX: 0, FOREX: 0, CRYPTO: 0 };
        segmentRows.forEach(r => { marginBySegment[r.market_type] = parseFloat(r.segment_margin); });

        // 4. Gross P/L from closed trades
        const [plRows] = await db.execute(
            'SELECT IFNULL(SUM(pnl), 0) as gross_pl FROM trades WHERE user_id = ? AND status = "CLOSED"',
            [userId]
        );
        const grossPL = parseFloat(plRows[0].gross_pl);

        // 5. Brokerage from closed trades
        const [brkRows] = await db.execute(
            'SELECT IFNULL(SUM(brokerage), 0) as total_brokerage FROM trades WHERE user_id = ? AND status = "CLOSED"',
            [userId]
        );
        const totalBrokerage = parseFloat(brkRows[0].total_brokerage);

        res.json({
            balance,
            credit_limit: parseFloat(userRows[0].credit_limit),
            margin_used: totalMarginUsed,
            margin_available: balance - totalMarginUsed,
            margin_by_segment: marginBySegment,
            gross_pl: grossPL,
            brokerage: totalBrokerage,
            net_pl: grossPL - totalBrokerage,
        });
    } catch (err) {
        console.error('getBalance error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
};

module.exports = { getLedger, internalTransfer, getBalance };
