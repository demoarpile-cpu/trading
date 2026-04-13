const db = require('../config/db');
const bcrypt = require('bcryptjs');

const getBannedOrders = async (req, res) => {
    try {
        const userId = req.user.id;
        const userRole = req.user.role;

        console.log(`[getBannedOrders] User ${userId} (${userRole}) requesting banned orders`);

        // For SUPERADMIN - sees only their own banned orders
        // For ADMIN - sees their own + their subordinates' orders
        let query = 'SELECT * FROM banned_limit_orders WHERE created_by = ? ORDER BY id DESC';
        let params = [userId];

        // For ADMIN, also include orders created by their direct children
        if (userRole === 'ADMIN') {
            query = `SELECT * FROM banned_limit_orders
                     WHERE created_by = ? OR created_by IN (
                         SELECT id FROM users WHERE parent_id = ?
                     )
                     ORDER BY id DESC`;
            params = [userId, userId];
        }

        console.log(`[getBannedOrders] Query params:`, params);
        const [rows] = await db.execute(query, params);
        console.log(`[getBannedOrders] Returned ${rows.length} banned orders`);
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server Error' });
    }
};

const createBannedOrder = async (req, res) => {
    const { scripId, startTime, endTime, transactionPassword } = req.body;
    try {
        // Validate transaction password
        const [users] = await db.execute('SELECT transaction_password FROM users WHERE id = ?', [req.user.id]);
        if (users.length && users[0].transaction_password) {
            if (!transactionPassword) {
                return res.status(400).json({ message: 'Transaction password is required' });
            }
            const isMatch = await bcrypt.compare(transactionPassword, users[0].transaction_password);
            if (!isMatch) {
                return res.status(400).json({ message: 'Invalid transaction password' });
            }
        }

        const [result] = await db.execute(
            'INSERT INTO banned_limit_orders (scrip_id, start_time, end_time, created_by) VALUES (?, ?, ?, ?)',
            [scripId, startTime, endTime, req.user.id]
        );
        res.status(201).json({ message: 'Scrip banned successfully', id: result.insertId });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server Error' });
    }
};

const deleteBannedOrder = async (req, res) => {
    const { id } = req.params;
    try {
        await db.execute('DELETE FROM banned_limit_orders WHERE id = ?', [id]);
        res.json({ message: 'Ban removed successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server Error' });
    }
};

const deleteMultipleBannedOrders = async (req, res) => {
    const { ids } = req.body; // Array of IDs
    if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ message: 'No IDs provided' });
    }
    try {
        const placeholders = ids.map(() => '?').join(',');
        const sql = `DELETE FROM banned_limit_orders WHERE id IN (${placeholders})`;
        await db.execute(sql, ids);
        res.json({ message: 'Bans removed successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server Error' });
    }
};

module.exports = {
    getBannedOrders,
    createBannedOrder,
    deleteBannedOrder,
    deleteMultipleBannedOrders
};
