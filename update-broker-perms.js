const mysql = require('mysql2/promise');

async function updateBrokerPermissions() {
    const connection = await mysql.createConnection({
        host: 'localhost',
        user: 'root',
        password: '',
        database: 'traderdb'
    });

    try {
        const query = `
            INSERT INTO broker_shares
            (user_id, permissions_json)
            VALUES (17, ?)
            ON DUPLICATE KEY UPDATE
            permissions_json = ?
        `;

        const permissionsJson = JSON.stringify({
            subBrokerActions: 'Yes',
            payinAllowed: 'No',
            payoutAllowed: 'No',
            createClientsAllowed: 'No',
            clientTasksAllowed: 'No',
            tradeActivityAllowed: 'No',
            notificationsAllowed: 'No',
            canViewBackupData: 'No'
        });

        const [result] = await connection.execute(query, [permissionsJson, permissionsJson]);
        console.log('✅ Broker permissions updated successfully!');
        console.log('Permissions set:', JSON.parse(permissionsJson));
    } catch (err) {
        console.error('❌ Error:', err.message);
    } finally {
        await connection.end();
    }
}

updateBrokerPermissions();
