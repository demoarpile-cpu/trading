const db = require('../config/db');
const { logAction } = require('./systemController');
const { uploadFile } = require('../utils/imagekit');

const getRequests = async (req, res) => {
    const { type, status } = req.query; // type: DEPOSIT/WITHDRAW, status: PENDING
    try {
        let query = `
            SELECT r.*, u.username, u.full_name, u.balance as current_balance
            FROM payment_requests r 
            JOIN users u ON r.user_id = u.id
            WHERE 1=1
        `;
        const params = [];

        if (type) { query += ' AND r.type = ?'; params.push(type); }
        if (status) { query += ' AND r.status = ?'; params.push(status); }
        
        // If not admin, only show own requests
        if (req.user.role !== 'SUPERADMIN' && req.user.role !== 'ADMIN') {
            query += ' AND r.user_id = ?';
            params.push(req.user.id);
        }

        query += ' ORDER BY r.created_at DESC';

        const [rows] = await db.execute(query, params);
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Internal Server Error' });
    }
};

const updateRequestStatus = async (req, res) => {
    const { id } = req.params;
    const { status, remark } = req.body; // status: APPROVED, REJECTED

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        // 1. Get Request Details
        const [requests] = await connection.execute('SELECT * FROM payment_requests WHERE id = ? AND status = "PENDING" FOR UPDATE', [id]);
        if (requests.length === 0) throw new Error('Request not found or already processed');
        const request = requests[0];

        if (status === 'APPROVED') {
            // 2. Update User Balance
            const operator = request.type === 'DEPOSIT' ? '+' : '-';
            // For withdrawals, check if user has enough balance
            if (request.type === 'WITHDRAW') {
                const [userRows] = await connection.execute('SELECT balance FROM users WHERE id = ?', [request.user_id]);
                if (userRows[0].balance < request.amount) throw new Error('Insufficient balance');
            }
            
            await connection.execute(`UPDATE users SET balance = balance ${operator} ? WHERE id = ?`, [request.amount, request.user_id]);

            // 3. Get New Balance for Ledger
            const [userRows] = await connection.execute('SELECT balance FROM users WHERE id = ?', [request.user_id]);
            const newBalance = userRows[0].balance;

            // 4. Record in Ledger
            await connection.execute(
                'INSERT INTO ledger (user_id, amount, type, balance_after, remarks) VALUES (?, ?, ?, ?, ?)',
                [request.user_id, request.amount, request.type, newBalance, remark || `Request Approved: ${request.type}`]
            );
        }

        // 5. Update Request Status
        await connection.execute('UPDATE payment_requests SET status = ?, admin_remarks = ? WHERE id = ?', [status, remark, id]);

        await connection.commit();
        await logAction(req.user.id, `${status}_PAYMENT`, 'payment_requests', `${status} ${request.type} of ${request.amount} for user ID ${request.user_id}`);
        
        res.json({ message: `Request ${status.toLowerCase()}` });
    } catch (err) {
        await connection.rollback();
        console.error(err);
        res.status(400).json({ message: err.message });
    } finally {
        connection.release();
    }
};

const createRequest = async (req, res) => {
    console.log('\n\n=== CREATING DEPOSIT REQUEST ===');
    console.log('User ID:', req.user?.id);
    console.log('User Role:', req.user?.role);
    console.log('Body:', req.body);
    console.log('File:', req.file ? { name: req.file.filename, size: req.file.size } : 'No file');

    const {
        amount,
        type,
        bankName,
        accountHolder,
        accountNumber,
        ifscCode,
        upiId,
        paymentMethod
    } = req.body; // type: DEPOSIT or WITHDRAW
    const userId = req.user.id;
    let screenshotUrl = null;

    console.log('Extracted: amount=' + amount + ', type=' + type);

    try {
        // Validate required fields
        if (!amount || !type) {
            return res.status(400).json({ message: 'Amount and type are required' });
        }

        if (req.file) {
            const uploaded = await uploadFile(req.file.buffer, req.file.originalname, '/deposits');
            screenshotUrl = uploaded.url;
            console.log('DEBUG: Screenshot uploaded to ImageKit:', screenshotUrl);
        }

        const [result] = await db.execute(
            'INSERT INTO payment_requests (user_id, amount, type, screenshot_url, bank_name, account_holder, account_number, ifsc_code, upi_id, payment_method, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, "PENDING")',
            [userId, amount, type, screenshotUrl, bankName || null, accountHolder || null, accountNumber || null, ifscCode || null, upiId || null, paymentMethod || null]
        );

        console.log('DEBUG: Request created with ID:', result.insertId);

        // Log action (don't fail if logging fails)
        try {
            await logAction(userId, `CREATE_${type}_REQUEST`, 'payment_requests', `User created ${type} request of ${amount}`);
        } catch (logErr) {
            console.warn('Warning: Failed to log action:', logErr.message);
        }

        res.status(201).json({
            message: 'Request created successfully',
            id: result.insertId
        });
    } catch (err) {
        console.error('ERROR in createRequest:', err.message, err.stack);
        res.status(500).json({ message: err.message || 'Internal Server Error' });
    }
};

module.exports = { getRequests, updateRequestStatus, createRequest };
