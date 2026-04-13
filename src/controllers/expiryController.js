const db = require('../config/db');

const getExpiryRules = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM expiry_rules WHERE id = 1');
        if (!rows.length) return res.json({});
        const row = rows[0];
        res.json({
            autoSquareOff: row.auto_square_off,
            expirySquareOffTime: row.square_off_time,
            allowExpiringScrip: row.allow_expiring_scrip,
            daysBeforeExpiry: String(row.days_before_expiry),
            mcxOptionsAwayPoints: row.away_points ? JSON.parse(row.away_points) : {}
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server Error' });
    }
};

const updateExpiryRules = async (req, res) => {
    const { autoSquareOff, expirySquareOffTime, allowExpiringScrip, daysBeforeExpiry, mcxOptionsAwayPoints } = req.body;
    try {
        await db.execute(
            `UPDATE expiry_rules SET
                auto_square_off      = ?,
                square_off_time      = ?,
                allow_expiring_scrip = ?,
                days_before_expiry   = ?,
                away_points          = ?
             WHERE id = 1`,
            [
                autoSquareOff || 'No',
                expirySquareOffTime || '11:30',
                allowExpiringScrip || 'No',
                parseInt(daysBeforeExpiry) || 0,
                mcxOptionsAwayPoints ? JSON.stringify(mcxOptionsAwayPoints) : null
            ]
        );
        res.json({ message: 'Expiry rules updated successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server Error' });
    }
};

module.exports = { getExpiryRules, updateExpiryRules };
