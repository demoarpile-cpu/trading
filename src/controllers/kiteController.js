const kiteAuthService = require('../services/KiteAuthService');
const kiteService = require('../utils/kiteService');

/**
 * Controller to handle Kite authentication requests.
 */
class KiteController {
    
    login = async (req, res) => {
        try {
            const userId = req.user.id;
            const url = `${kiteAuthService.getLoginURL()}&state=${userId}`;
            res.json({ login_url: url });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    }

    callback = async (req, res) => {
        const { request_token, state: userId, status } = req.query;
        // Detect local vs production for redirect
        const isLocal = req.hostname === 'localhost' || req.hostname === '127.0.0.1';
        const FRONTEND_URL = isLocal ? 'http://localhost:5173' : (process.env.FRONTEND_URL || 'http://localhost:5173');

        if (status === 'cancelled') {
            return res.send(`<html><body style="background:#1a1a2e;color:#fff;text-align:center;padding:50px;font-family:sans-serif;">
                <h1 style="color:#e74c3c">Login Cancelled</h1>
                <p style="color:#ccc">Redirecting back...</p>
                <script>setTimeout(()=>{ window.location.href='${FRONTEND_URL}/kite-dashboard'; },2000)</script>
            </body></html>`);
        }

        if (!request_token) {
            return res.status(400).send(`<html><body style="background:#1a1a2e;color:#fff;text-align:center;padding:50px;font-family:sans-serif;">
                <h1 style="color:#e74c3c">Error</h1>
                <p style="color:#ccc">No request token received from Zerodha.</p>
                <script>setTimeout(()=>{ window.location.href='${FRONTEND_URL}/kite-dashboard'; },3000)</script>
            </body></html>`);
        }

        try {
            // Generate session using global kiteService (works without userId)
            const session = await kiteService.handleCallback(request_token);
            const accessToken = session.access_token || '';

            console.log('=========================================');
            console.log('KITE ACCESS TOKEN:', accessToken);
            console.log('USER:', session.user_name || session.user_id || 'N/A');
            console.log('=========================================');

            // Also save to per-user DB if userId was passed via state param
            if (userId) {
                try {
                    await kiteAuthService.handleCallback(userId, request_token);
                } catch (dbErr) {
                    // Per-user save may fail if request_token already used, that's OK — global is set
                    console.warn('Per-user DB save skipped:', dbErr.message);
                }
            }

            // Detect redirect: use request origin or fallback to localhost for local dev
            const redirectURL = `${FRONTEND_URL}/kite-dashboard`;

            res.send(`
                <html><body style="background:#1a1a2e;color:#fff;text-align:center;padding:50px;font-family:sans-serif;">
                    <h1 style="color:#2ecc71">Kite Connected!</h1>
                    <p style="color:#ccc">User: <strong>${session.user_name || session.user_id || 'N/A'}</strong></p>
                    <div style="background:#0f1729;border:1px solid #2ecc71;border-radius:8px;padding:15px;margin:20px auto;max-width:500px;text-align:left;">
                        <p style="color:#888;font-size:11px;margin:0 0 5px;">ACCESS TOKEN (copy if needed):</p>
                        <p style="color:#2ecc71;font-family:monospace;font-size:13px;word-break:break-all;margin:0;user-select:all;">${accessToken}</p>
                    </div>
                    <p style="color:#888;font-size:13px;">Redirecting to dashboard in 3s...</p>
                    <script>
                        setTimeout(() => {
                            window.location.href = '${redirectURL}';
                        }, 3000);
                    </script>
                </body></html>
            `);
        } catch (err) {
            console.error('Kite callback error:', err.message);
            res.status(500).send(`<html><body style="background:#1a1a2e;color:#fff;text-align:center;padding:50px;font-family:sans-serif;">
                <h1 style="color:#e74c3c">Auth Failed</h1>
                <p style="color:#ccc">${err.message}</p>
                <p style="color:#888">Redirecting back...</p>
                <script>setTimeout(()=>{ window.location.href='${FRONTEND_URL}/kite-dashboard'; },3000)</script>
            </body></html>`);
        }
    }

    status = async (req, res) => {
        try {
            const userId = req.user.id;
            // Check per-user DB session first
            const dbStatus = await kiteAuthService.getStatus(userId);
            if (dbStatus.connected) {
                return res.json(dbStatus);
            }
            // Fallback: check global kiteService (set by Zerodha callback or .env)
            if (kiteService.isAuthenticated()) {
                const globalStatus = kiteService.getStatus();
                return res.json(globalStatus);
            }
            res.json({ connected: false });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    }

    disconnect = async (req, res) => {
        try {
            const userId = req.user.id;
            await kiteAuthService.disconnect(userId);
            // Clear global kiteService too
            kiteService.clearSession();
            res.json({ success: true, message: 'Kite disconnected' });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    }

    getMargins = async (req, res) => {
        try {
            const userId = req.user.id;
            const kite = await kiteAuthService.getKiteInstance(userId);
            const margins = await kite.getMargins();
            res.json(margins);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    }

    getProfile = async (req, res) => {
        try {
            const userId = req.user.id;
            const kite = await kiteAuthService.getKiteInstance(userId);
            const profile = await kite.getProfile();
            res.json(profile);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    }

    setToken = async (req, res) => {
        try {
            const userId = req.user.id;
            const { access_token } = req.body;

            if (!access_token) {
                return res.status(400).json({ error: 'access_token is required' });
            }

            // Validate token with Kite API BEFORE saving
            let profile;
            try {
                profile = await kiteService.setAccessToken(access_token);
            } catch (validationErr) {
                return res.status(400).json({ error: 'Invalid access token. Please check and try again.' });
            }

            // Token is valid — save to per-user DB (skip re-validation)
            await kiteAuthService.saveTokenToDB(userId, access_token, profile);
            console.log('🔗 Kite token validated & synced. User:', profile?.user_name || 'N/A');

            res.json({ success: true, message: 'Access token set successfully', user: profile?.user_name || null });
        } catch (err) {
            // Clear everything on failure
            kiteService.clearSession();
            res.status(500).json({ error: err.message });
        }
    }
}

module.exports = new KiteController();
