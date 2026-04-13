const express = require('express');
const router = express.Router();
const dashboardController = require('../controllers/dashboardController');
const { authMiddleware } = require('../middleware/auth');

router.get('/live-m2m', authMiddleware, dashboardController.getClientLiveM2M);
router.get('/live-market', authMiddleware, dashboardController.getLiveMarket);
router.get('/broker-m2m', authMiddleware, dashboardController.getBrokerM2M);
router.get('/market-watch', authMiddleware, dashboardController.getMarketWatch);
router.get('/indices', authMiddleware, dashboardController.getIndices);
router.get('/watchlist', authMiddleware, dashboardController.getWatchlist);

module.exports = router;
