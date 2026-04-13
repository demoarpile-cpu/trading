const db = require('../src/config/db');
const bcrypt = require('bcryptjs');

async function checkUsers() {
    try {
        const usernames = ['superadmin', 'admin', 'broker', 'trader'];
        console.log('--- PASSWORD VERIFICATION REPORT ---');
        for (const username of usernames) {
            const [rows] = await db.execute('SELECT * FROM users WHERE username = ?', [username]);
            if (rows.length === 0) {
                console.log(`[NOT FOUND] ${username}`);
            } else {
                const user = rows[0];
                const isMatchAdmin = await bcrypt.compare('admin123', user.password);
                const isMatchTrader = await bcrypt.compare('trader123', user.password);
                
                console.log(`User: ${username.padEnd(12)} | Role: ${user.role.padEnd(12)} | Pass="admin123": ${isMatchAdmin} | Pass="trader123": ${isMatchTrader}`);
            }
        }
    } catch (err) {
        console.error('Error:', err);
    } finally {
        process.exit();
    }
}

checkUsers();
