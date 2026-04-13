const express = require('express');
const router = express.Router();
const { getActionLedger, globalBatchUpdate, getSegmentValues, resetSegmentValues } = require('../controllers/systemController');
const { getAllScrips, updateScrip, getTickers, createTicker, updateTicker, deleteTicker } = require('../controllers/scripController');
const { getBannedOrders, createBannedOrder, deleteBannedOrder, deleteMultipleBannedOrders } = require('../controllers/bannedController');
const { getExpiryRules, updateExpiryRules } = require('../controllers/expiryController');
const { authMiddleware, roleMiddleware } = require('../middleware/auth');

router.get('/audit-log',       authMiddleware, roleMiddleware(['SUPERADMIN','ADMIN']), getActionLedger);
router.post('/global-update',  authMiddleware, roleMiddleware(['SUPERADMIN']), globalBatchUpdate);
router.get('/segment-values',  authMiddleware, roleMiddleware(['SUPERADMIN','ADMIN']), getSegmentValues);
router.post('/reset-segment',  authMiddleware, roleMiddleware(['SUPERADMIN']), resetSegmentValues);

// Scrip & Ticker Management
router.get('/scrips', authMiddleware, getAllScrips);
router.put('/scrips', authMiddleware, roleMiddleware(['SUPERADMIN']), updateScrip);
router.get('/tickers', authMiddleware, getTickers);
router.post('/tickers', authMiddleware, roleMiddleware(['SUPERADMIN', 'ADMIN']), createTicker);
router.put('/tickers/:id', authMiddleware, roleMiddleware(['SUPERADMIN', 'ADMIN']), updateTicker);
router.delete('/tickers/:id', authMiddleware, roleMiddleware(['SUPERADMIN', 'ADMIN']), deleteTicker);

// Expiry Rules
router.get('/expiry-rules', authMiddleware, getExpiryRules);
router.put('/expiry-rules', authMiddleware, roleMiddleware(['SUPERADMIN', 'ADMIN']), updateExpiryRules);

// Banned Limit Orders
router.get('/banned-orders', authMiddleware, getBannedOrders);
router.post('/banned-orders', authMiddleware, roleMiddleware(['SUPERADMIN', 'ADMIN']), createBannedOrder);
router.delete('/banned-orders/:id', authMiddleware, roleMiddleware(['SUPERADMIN', 'ADMIN']), deleteBannedOrder);
router.post('/banned-orders/delete-multiple', authMiddleware, roleMiddleware(['SUPERADMIN', 'ADMIN']), deleteMultipleBannedOrders);

module.exports = router;
