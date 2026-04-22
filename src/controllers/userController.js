const db = require('../config/db');
const bcrypt = require('bcryptjs');
const { logAction } = require('./systemController');
const { getFromCache, saveToCache, invalidateCache } = require('../utils/cacheManager');

const { uploadFile, deleteFile } = require('../utils/imagekit');

const getUsers = async (req, res) => {
    try {
        const { role } = req.query;
        const currentUserId = req.user.id;
        const currentUserRole = req.user.role;

        console.log(`[getUsers] User ${currentUserId} (${currentUserRole}) requesting users with role filter: ${role || 'all'}`);

        // Try to get from cache first (safe: if fails, continues to DB query)
        const cacheKey = `users_${currentUserId}_${role || 'all'}`;
        try {
            const cachedData = await getFromCache(cacheKey);
            if (cachedData) {
                return res.json(cachedData);
            }
        } catch (cacheErr) {
            console.log(`[getUsers] Cache read failed, proceeding with DB query`);
        }

        let query = `
            SELECT
                u.*,
                p.username as parent_username,
                p.full_name as parent_name,
                u.balance as ledger_balance,
                u.credit_limit,
                IFNULL(ud.kyc_status, 'PENDING') as kycStatus,
                IFNULL((SELECT SUM(pnl) FROM trades WHERE user_id = u.id AND status = 'CLOSED'), 0.00) as gross_pl,
                0.00 as brokerage,
                0.00 as swap_charges,
                IFNULL((SELECT SUM(pnl) FROM trades WHERE user_id = u.id AND status = 'CLOSED'), 0.00) as net_pl,
                (SELECT COUNT(*) FROM trades WHERE user_id = u.id AND status = 'OPEN') as active_trades_count,
                cs.config_json,
                cs.broker_id
            FROM users u
            LEFT JOIN users p ON u.parent_id = p.id
            LEFT JOIN user_documents ud ON u.id = ud.user_id
            LEFT JOIN client_settings cs ON u.id = cs.user_id
            WHERE 1=1
        `;
        const params = [];

        // Apply hierarchy filtering based on role
        // SUPERADMIN/ADMIN: See only clients they created (parent_id = current user id)
        // BROKER: If viewing BROKER role, see sub-brokers (parent_id = current user id)
        //         If viewing TRADER role, see assigned clients (broker_id = current user id)
        // OTHERS: See only their own created clients (parent_id = current user id)

        if (role) {
            query += ' AND u.role = ?';
            params.push(role);
        }

        if (currentUserRole === 'SUPERADMIN') {
            // SUPERADMIN: See only users they directly created
            console.log(`[getUsers] SUPERADMIN ${currentUserId} viewing their own direct users`);
            query += ' AND u.parent_id = ?';
            params.push(currentUserId);
        } else if (currentUserRole === 'ADMIN') {
            // ADMIN: See users they created OR users assigned to their brokers
            query += ' AND (u.parent_id = ? OR u.id IN (SELECT user_id FROM client_settings WHERE broker_id IN (SELECT id FROM users WHERE parent_id = ?)))';
            params.push(currentUserId, currentUserId);
        } else if (currentUserRole === 'BROKER') {
            // BROKER: See users where they are the parent OR assigned broker
            query += ' AND (u.parent_id = ? OR cs.broker_id = ?)';
            params.push(currentUserId, currentUserId);
        } else {
            // Default/Trader/Other: See only themselves or their direct creations
            query += ' AND u.parent_id = ?';
            params.push(currentUserId);
        }

        console.log(`[getUsers] Executing query with params:`, params);

        const [rows] = await db.execute(query, params);
        console.log(`[getUsers] Returned ${rows.length} users`);

        // Save to cache (safe: if fails, response still sent)
        try {
            await saveToCache(cacheKey, rows, 300); // 5 min cache
        } catch (cacheErr) {
            console.log(`[getUsers] Cache save failed, but data sent`);
        }

        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
};

const getUserProfile = async (req, res) => {
    try {
        const [userRows] = await db.execute('SELECT * FROM users WHERE id = ?', [req.params.id]);
        if (userRows.length === 0) return res.status(404).json({ message: 'User not found' });

        const [settingsRows] = await db.execute('SELECT * FROM client_settings WHERE user_id = ?', [req.params.id]);
        const [brokerSharesRows] = await db.execute('SELECT * FROM broker_shares WHERE user_id = ?', [req.params.id]);
        const [segmentRows] = await db.execute('SELECT * FROM user_segments WHERE user_id = ?', [req.params.id]);
        const [docRows] = await db.execute('SELECT * FROM user_documents WHERE user_id = ?', [req.params.id]);

        const settings = settingsRows[0] || {};
        if (settings.config_json) {
            try { settings.config = JSON.parse(settings.config_json); } catch (e) { settings.config = {}; }
        }

        const brokerShares = brokerSharesRows[0] || {};
        if (brokerShares.permissions_json) {
            try { brokerShares.permissions = JSON.parse(brokerShares.permissions_json); } catch (e) { brokerShares.permissions = {}; }
        }
        if (brokerShares.segments_json) {
            try { brokerShares.segments = JSON.parse(brokerShares.segments_json); } catch (e) { brokerShares.segments = {}; }
        }

        res.json({
            profile: userRows[0],
            settings,
            brokerShares,
            segments: segmentRows,
            documents: docRows[0] || {}
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
};

const updateStatus = async (req, res) => {
    const { status } = req.body;
    const targetUserId = req.params.id;
    const currentUserId = req.user.id;
    const currentUserRole = req.user.role;
    try {
        // Brokers can only update status for their own created users or assigned clients
        if (currentUserRole === 'BROKER') {
            const [userRows] = await db.execute(
                'SELECT id FROM users WHERE id = ? AND (parent_id = ? OR broker_id = ?)',
                [targetUserId, currentUserId, currentUserId]
            );
            if (userRows.length === 0) {
                return res.status(403).json({ message: 'You can only update status for your own clients' });
            }
        }

        await db.execute('UPDATE users SET status = ? WHERE id = ?', [status, targetUserId]);

        // Log the action
        await logAction(currentUserId, 'UPDATE_STATUS', 'users', `Updated status of user ID ${targetUserId} to ${status}`);

        // Invalidate caches
        try {
            await invalidateCache(`users_${currentUserId}_all`);
            await invalidateCache(`users_${currentUserId}_TRADER`);
            await invalidateCache(`users_${currentUserId}_BROKER`);
        } catch (e) {}

        res.json({ message: 'Status updated successfully' });
    } catch (err) {

        console.error(err);
        res.status(500).send('Server Error');
    }
};

const resetPassword = async (req, res) => {
    const { newPassword } = req.body;
    try {
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await db.execute('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, req.params.id]);
        
        // Log the action
        await logAction(req.user.id, 'RESET_PASSWORD', 'users', `Reset password for user ID ${req.params.id}`);

        res.json({ message: 'Password reset successfully' });
    } catch (err) {

        console.error(err);
        res.status(500).send('Server Error');
    }
};

const updatePasswords = async (req, res) => {
    const { newPassword, transactionPassword } = req.body;
    try {
        if (newPassword) {
            const hashedPassword = await bcrypt.hash(newPassword, 10);
            await db.execute('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, req.params.id]);
        }
        if (transactionPassword) {
            const hashedTransPassword = await bcrypt.hash(transactionPassword, 10);
            await db.execute('UPDATE users SET transaction_password = ? WHERE id = ?', [hashedTransPassword, req.params.id]);
        }
        res.json({ message: 'Passwords updated successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
};

const deleteUser = async (req, res) => {
    try {
        const targetUserId = req.params.id;
        const currentUserId = req.user.id;
        const currentUserRole = req.user.role;

        // Brokers can only delete their own created users or assigned clients
        if (currentUserRole === 'BROKER') {
            const [userRows] = await db.execute(
                'SELECT id FROM users WHERE id = ? AND (parent_id = ? OR broker_id = ?)',
                [targetUserId, currentUserId, currentUserId]
            );
            if (userRows.length === 0) {
                return res.status(403).json({ message: 'You can only delete your own clients' });
            }
        }

        await db.execute('DELETE FROM users WHERE id = ?', [targetUserId]);

        // Log the action
        await logAction(currentUserId, 'DELETE_USER', 'users', `Deleted user ID ${targetUserId}`);

        // Invalidate caches
        try {
            await invalidateCache(`users_${currentUserId}_all`);
            await invalidateCache(`users_${currentUserId}_TRADER`);
            await invalidateCache(`users_${currentUserId}_BROKER`);
        } catch (e) {}

        res.json({ message: 'User deleted successfully' });
    } catch (err) {

        console.error(err);
        res.status(500).send('Server Error');
    }
};

// ─── UPDATE USER PROFILE ─────────────────────────────
const updateUser = async (req, res) => {
    const { fullName, email, mobile, city, creditLimit, exposureMultiplier, isDemo, status, parentId } = req.body;
    try {
        const fields = [];
        const values = [];

        if (fullName !== undefined)         { fields.push('full_name = ?');          values.push(fullName); }
        if (email !== undefined)            { fields.push('email = ?');              values.push(email); }
        if (mobile !== undefined)           { fields.push('mobile = ?');             values.push(mobile); }
        if (city !== undefined)             { fields.push('city = ?');               values.push(city); }
        if (creditLimit !== undefined)      { fields.push('credit_limit = ?');       values.push(creditLimit); }
        if (exposureMultiplier !== undefined){ fields.push('exposure_multiplier = ?'); values.push(exposureMultiplier); }
        if (isDemo !== undefined)           { fields.push('is_demo = ?');            values.push(isDemo ? 1 : 0); }
        if (status !== undefined)           { fields.push('status = ?');             values.push(status); }
        if (parentId !== undefined)         { fields.push('parent_id = ?');          values.push(parseInt(parentId) || null); }

        if (fields.length === 0) return res.status(400).json({ message: 'No fields to update' });

        values.push(req.params.id);
        await db.execute(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, values);

        // Log the action with summary of changes
        const summary = Object.keys(req.body).join(', ');
        await logAction(req.user.id, 'UPDATE_USER', 'users', `Updated user ID ${req.params.id}: modified ${summary}`);

        // Invalidate ALL user list caches to ensure consistency across all admins/brokers
        try {
            await invalidateCache(`users_${req.user.id}_all`);
            await invalidateCache(`users_${req.user.id}_TRADER`);
            await invalidateCache(`users_${req.user.id}_BROKER`);
            
            // Also invalidate the parent's cache if different
            if (parentId && parseInt(parentId) !== req.user.id) {
                await invalidateCache(`users_${parentId}_all`);
                await invalidateCache(`users_${parentId}_TRADER`);
                await invalidateCache(`users_${parentId}_BROKER`);
            }
            
            console.log(`[Cache] Cleared user list caches for updater ${req.user.id}`);
        } catch (e) {
            console.log(`[Cache] Clear failed but update succeeded`);
        }

        res.json({ message: 'User updated successfully' });
    } catch (err) {

        console.error(err);
        res.status(500).send('Server Error');
    }
};

// ─── CLIENT SETTINGS ─────────────────────────────────
const updateClientSettings = async (req, res) => {
    const {
        allowFreshEntry, allowOrdersBetweenHL, tradeEquityUnits,
        autoCloseEnabled, banAllSegmentLimitOrder,
        autoClosePct, notifyPct, minProfitTime, scalpingSlEnabled,
        brokerId,  // Broker assignment
        config  // full complex config JSON (all segment data)
    } = req.body;

    try {
        let configObj = config || {};
        if (autoCloseEnabled !== undefined) configObj.autoCloseEnabled = autoCloseEnabled;

        // ─── If broker is assigned, fetch & apply broker's segment config ─────
        if (brokerId) {
            console.log(`[updateClientSettings] Broker assigned (ID: ${brokerId}). Fetching broker's segment config...`);
            const [brokerSharesRows] = await db.execute(
                'SELECT segments_json FROM broker_shares WHERE user_id = ?',
                [brokerId]
            );

            if (brokerSharesRows.length > 0 && brokerSharesRows[0].segments_json) {
                try {
                    const brokerSegments = JSON.parse(brokerSharesRows[0].segments_json);
                    if (brokerSegments.segmentConfig) {
                        console.log(`[updateClientSettings] ✅ Applied broker's segment config to client`);
                        // Apply broker's segment configuration to client
                        configObj.brokerSegments = brokerSegments.segmentConfig;
                        configObj.brokerMcxMargins = brokerSegments.mcxMargins || {};
                        configObj.brokerMcxBrokerage = brokerSegments.mcxBrokerage || {};
                    }
                } catch (e) {
                    console.error(`[updateClientSettings] Failed to parse broker segments:`, e);
                }
            }
        }

        const configJson = Object.keys(configObj).length > 0 ? JSON.stringify(configObj) : null;

        await db.execute(`
            INSERT INTO client_settings
                (user_id, allow_fresh_entry, allow_orders_between_hl, trade_equity_units,
                 auto_close_at_m2m_pct, notify_at_m2m_pct, min_time_to_book_profit,
                 scalping_sl_enabled, ban_all_segment_limit_order, config_json, broker_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                allow_fresh_entry = VALUES(allow_fresh_entry),
                allow_orders_between_hl = VALUES(allow_orders_between_hl),
                trade_equity_units = VALUES(trade_equity_units),
                auto_close_at_m2m_pct = VALUES(auto_close_at_m2m_pct),
                notify_at_m2m_pct = VALUES(notify_at_m2m_pct),
                min_time_to_book_profit = VALUES(min_time_to_book_profit),
                scalping_sl_enabled = VALUES(scalping_sl_enabled),
                ban_all_segment_limit_order = VALUES(ban_all_segment_limit_order),
                config_json = VALUES(config_json),
                broker_id = VALUES(broker_id)
        `, [
            req.params.id,
            allowFreshEntry !== undefined ? (allowFreshEntry ? 1 : 0) : 1,
            allowOrdersBetweenHL !== undefined ? (allowOrdersBetweenHL ? 1 : 0) : 1,
            tradeEquityUnits !== undefined ? (tradeEquityUnits ? 1 : 0) : 0,
            autoClosePct !== undefined ? autoClosePct : 90,
            notifyPct !== undefined ? notifyPct : 70,
            minProfitTime !== undefined ? minProfitTime : 120,
            scalpingSlEnabled !== undefined ? (scalpingSlEnabled === true || scalpingSlEnabled === 'Enabled' ? 1 : 0) : 0,
            banAllSegmentLimitOrder !== undefined ? (banAllSegmentLimitOrder ? 1 : 0) : 0,
            configJson,
            brokerId || null
        ]);

        res.json({ message: 'Client settings updated' });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
};

// ─── BROKER SHARES ───────────────────────────────────
const getBrokerShares = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM broker_shares WHERE user_id = ?', [req.params.id]);
        const data = rows[0] || {};
        if (data.permissions_json) {
            try { data.permissions = JSON.parse(data.permissions_json); } catch (e) { data.permissions = {}; }
        }
        if (data.segments_json) {
            try { data.segments = JSON.parse(data.segments_json); } catch (e) { data.segments = {}; }
        }
        res.json(data);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
};

const updateBrokerShares = async (req, res) => {
    const {
        sharePL, shareBrokerage, shareSwap, brokerageType,
        tradingClientsLimit, subBrokersLimit, permissions, segments, swapRate
    } = req.body;

    try {
        await db.execute(`
            INSERT INTO broker_shares
                (user_id, share_pl_pct, share_brokerage_pct, share_swap_pct,
                 brokerage_type, trading_clients_limit, sub_brokers_limit,
                 permissions_json, segments_json, swap_rate)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                share_pl_pct = VALUES(share_pl_pct),
                share_brokerage_pct = VALUES(share_brokerage_pct),
                share_swap_pct = VALUES(share_swap_pct),
                brokerage_type = VALUES(brokerage_type),
                trading_clients_limit = VALUES(trading_clients_limit),
                sub_brokers_limit = VALUES(sub_brokers_limit),
                permissions_json = VALUES(permissions_json),
                segments_json = VALUES(segments_json),
                swap_rate = VALUES(swap_rate)
        `, [
            req.params.id,
            sharePL || 0,
            shareBrokerage || 50,
            shareSwap || 10,
            brokerageType || 'Percentage',
            tradingClientsLimit || 10,
            subBrokersLimit || 3,
            permissions ? JSON.stringify(permissions) : null,
            segments ? JSON.stringify(segments) : null,
            swapRate || 5  // Default ₹5 per lot per day
        ]);

        res.json({ message: 'Broker shares updated' });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
};

// ─── DOCUMENTS ───────────────────────────────────────
const getDocuments = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM user_documents WHERE user_id = ?', [req.params.id]);
        res.json(rows[0] || {});
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
};

const updateDocuments = async (req, res) => {
    const { panNumber, aadharNumber, kycStatus } = req.body;
    const files = req.files || {};

    try {
        // Upload files to ImageKit
        let panScreenshot, aadharFront, aadharBack, bankProof;

        if (files.panScreenshot && files.panScreenshot[0]) {
            const result = await uploadFile(files.panScreenshot[0].buffer, files.panScreenshot[0].originalname, `/traders/kyc/${req.params.id}`);
            panScreenshot = result.url;
        }
        if (files.aadharFront && files.aadharFront[0]) {
            const result = await uploadFile(files.aadharFront[0].buffer, files.aadharFront[0].originalname, `/traders/kyc/${req.params.id}`);
            aadharFront = result.url;
        }
        if (files.aadharBack && files.aadharBack[0]) {
            const result = await uploadFile(files.aadharBack[0].buffer, files.aadharBack[0].originalname, `/traders/kyc/${req.params.id}`);
            aadharBack = result.url;
        }
        if (files.bankProof && files.bankProof[0]) {
            const result = await uploadFile(files.bankProof[0].buffer, files.bankProof[0].originalname, `/traders/kyc/${req.params.id}`);
            bankProof = result.url;
        }

        // Build dynamic upsert
        const setFields = ['user_id = ?'];
        const values = [req.params.id];

        if (panNumber !== undefined)     { setFields.push('pan_number = ?');     values.push(panNumber); }
        if (aadharNumber !== undefined)  { setFields.push('aadhar_number = ?');  values.push(aadharNumber); }
        if (kycStatus !== undefined)     { setFields.push('kyc_status = ?');     values.push(kycStatus); }
        if (panScreenshot !== undefined) { setFields.push('pan_screenshot = ?'); values.push(panScreenshot); }
        if (aadharFront !== undefined)   { setFields.push('aadhar_front = ?');   values.push(aadharFront); }
        if (aadharBack !== undefined)    { setFields.push('aadhar_back = ?');    values.push(aadharBack); }
        if (bankProof !== undefined)     { setFields.push('bank_proof = ?');     values.push(bankProof); }

        // Safety: If no documents are being updated (only user_id is in setFields), return early
        if (setFields.length <= 1 && panNumber === undefined && aadharNumber === undefined && kycStatus === undefined) {
            return res.json({ message: 'No changes detected' });
        }

        await db.execute(`
            INSERT INTO user_documents (${setFields.map(f => f.split(' = ?')[0]).join(', ')})
            VALUES (${values.map(() => '?').join(', ')})
            ON DUPLICATE KEY UPDATE
                ${setFields.filter(f => !f.startsWith('user_id')).join(', ')}
        `, [...values, ...values.slice(1).filter((v, i) => !setFields[i + 1].startsWith('user_id'))]);

        // Return the uploaded URLs so frontend can display them
        res.json({
            message: 'Documents updated',
            urls: {
                panScreenshot: panScreenshot || undefined,
                aadharFront: aadharFront || undefined,
                aadharBack: aadharBack || undefined,
                bankProof: bankProof || undefined
            }
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
};

// ─── USER SEGMENTS ───────────────────────────────────
const getUserSegments = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM user_segments WHERE user_id = ?', [req.params.id]);
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
};

const updateUserSegments = async (req, res) => {
    // segments: array of { segment, isEnabled, brokerageType, brokerageValue, leverage, maxLotPerScrip, marginType, exposureMultiplier, autoSquareOff, squareOffTime }
    const { segments } = req.body;
    if (!Array.isArray(segments)) return res.status(400).json({ message: 'segments must be an array' });

    try {
        for (const seg of segments) {
            await db.execute(`
                INSERT INTO user_segments
                    (user_id, segment, is_enabled, brokerage_type, brokerage_value,
                     leverage, max_lot_per_scrip, margin_type, exposure_multiplier,
                     auto_square_off, square_off_time)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    is_enabled = VALUES(is_enabled),
                    brokerage_type = VALUES(brokerage_type),
                    brokerage_value = VALUES(brokerage_value),
                    leverage = VALUES(leverage),
                    max_lot_per_scrip = VALUES(max_lot_per_scrip),
                    margin_type = VALUES(margin_type),
                    exposure_multiplier = VALUES(exposure_multiplier),
                    auto_square_off = VALUES(auto_square_off),
                    square_off_time = VALUES(square_off_time)
            `, [
                req.params.id,
                seg.segment,
                seg.isEnabled ? 1 : 0,
                seg.brokerageType || 'PER_LOT',
                seg.brokerageValue || 0,
                seg.leverage || 1,
                seg.maxLotPerScrip || 10,
                seg.marginType || 'PER_LOT',
                seg.exposureMultiplier || 1,
                seg.autoSquareOff ? 1 : 0,
                seg.squareOffTime || null
            ]);
        }
        res.json({ message: 'Segments updated' });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
};

const getBrokerClients = async (req, res) => {
    try {
        const brokerId = req.params.id;
        const brokerIdStr = String(brokerId);

        const [rows] = await db.execute(
            `SELECT u.id, u.username, u.full_name, u.email, u.mobile, u.status, u.role,
                    u.balance as ledger_balance, u.created_at, u.is_demo,
                    p.username as parent_username
             FROM users u
             LEFT JOIN client_settings cs ON cs.user_id = u.id
             LEFT JOIN users p ON u.parent_id = p.id
             WHERE u.role = 'TRADER' AND (
                u.parent_id = ?
                OR cs.broker_id = ?
                OR cs.config_json LIKE CONCAT('%"broker":"', ?, ' :%')
             )
             ORDER BY u.id ASC`,
            [brokerId, brokerId, brokerIdStr]
        );
        res.json(rows);
    } catch (err) {
        console.error('getBrokerClients error:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
};

/**
 * Reset Account — deletes all trades, refunds margin, resets PnL for a user
 * Ledger balance and fund transactions remain untouched
 */
const resetAccount = async (req, res) => {
    const userId = req.params.id;
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        // 1. Get all OPEN trades to refund margin
        const [openTrades] = await connection.execute(
            'SELECT SUM(margin_used) as totalMargin FROM trades WHERE user_id = ? AND status = "OPEN"',
            [userId]
        );
        const marginToRefund = parseFloat(openTrades[0]?.totalMargin || 0);

        // 2. Delete all trades for this user
        const [deleteResult] = await connection.execute(
            'DELETE FROM trades WHERE user_id = ?', [userId]
        );

        // 3. Refund locked margin back to balance
        if (marginToRefund > 0) {
            await connection.execute(
                'UPDATE users SET balance = balance + ? WHERE id = ?',
                [marginToRefund, userId]
            );
        }

        await connection.commit();

        await logAction(req.user.id, 'RESET_ACCOUNT', 'users',
            `Reset account for user #${userId}. Deleted ${deleteResult.affectedRows} trades, refunded margin: ${marginToRefund}`);

        res.json({
            message: 'Account reset successfully',
            tradesDeleted: deleteResult.affectedRows,
            marginRefunded: marginToRefund
        });
    } catch (err) {
        await connection.rollback();
        console.error('Reset Account Error:', err);
        res.status(500).json({ message: 'Failed to reset account' });
    } finally {
        connection.release();
    }
};

/**
 * Recalculate Brokerage — recalculates brokerage for all closed trades of a user
 * Uses broker's lot-wise brokerage configuration if available
 */
const recalculateBrokerage = async (req, res) => {
    const userId = req.params.id;
    try {
        // Get user's client settings for brokerage config
        const [settingsRows] = await db.execute(
            'SELECT config_json FROM client_settings WHERE user_id = ?', [userId]
        );
        const config = settingsRows.length > 0 ? JSON.parse(settingsRows[0].config_json || '{}') : {};

        // Get all closed trades
        const [trades] = await db.execute(
            'SELECT id, symbol, qty, entry_price, exit_price, type FROM trades WHERE user_id = ? AND status = "CLOSED"',
            [userId]
        );

        let totalBrokerage = 0;
        const brokerMcxBrokerage = config.brokerMcxBrokerage || config.mcxLotBrokerage || {};

        for (const trade of trades) {
            let brokerage = 0;

            // Try broker's lot-wise brokerage first
            if (brokerMcxBrokerage[trade.symbol] !== undefined) {
                brokerage = trade.qty * parseFloat(brokerMcxBrokerage[trade.symbol]);
                console.log(`[recalcBrokerage] Symbol=${trade.symbol}, Qty=${trade.qty}, BrokeragePerLot=${brokerMcxBrokerage[trade.symbol]}, Total=${brokerage}`);
            } else {
                // Fallback to config
                const brokeragePerLot = parseFloat(config.mcxBrokerage || 0);
                const brokerageType = config.mcxBrokerageType || 'per_crore';

                if (brokerageType === 'per_lot') {
                    brokerage = trade.qty * brokeragePerLot;
                } else {
                    // per crore basis
                    const turnover = trade.qty * (parseFloat(trade.entry_price) + parseFloat(trade.exit_price || 0));
                    brokerage = (turnover / 10000000) * brokeragePerLot;
                }
            }

            totalBrokerage += brokerage;
            await db.execute('UPDATE trades SET brokerage = ? WHERE id = ?', [brokerage, trade.id]);
        }

        await logAction(req.user.id, 'RECALCULATE_BROKERAGE', 'users',
            `Recalculated brokerage for user #${userId}. Total: ${totalBrokerage.toFixed(2)} across ${trades.length} trades`);

        res.json({
            message: 'Brokerage recalculated successfully',
            tradesUpdated: trades.length,
            totalBrokerage: totalBrokerage.toFixed(2)
        });
    } catch (err) {
        console.error('Recalculate Brokerage Error:', err);
        res.status(500).json({ message: 'Failed to recalculate brokerage' });
    }
};

module.exports = {
    getUsers, getUserProfile, updateStatus, resetPassword, deleteUser, updatePasswords,
    updateUser, updateClientSettings, getBrokerShares, updateBrokerShares,
    getDocuments, updateDocuments, getUserSegments, updateUserSegments, getBrokerClients,
    resetAccount, recalculateBrokerage
};
