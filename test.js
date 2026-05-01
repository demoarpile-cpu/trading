const db=require('./src/config/db'); 
async function run() {
    const [result] = await db.execute("DELETE FROM trades WHERE user_id=109 AND status='CLOSED'");
    console.log(`Deleted ${result.affectedRows} trades`);
    process.exit();
}
run();
