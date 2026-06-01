const crypto = require('crypto');
const path = require('path');

function registerAuthRoutes(app, context) {
    const {
        originValidationMiddleware,
        getClientIp,
        publicDir,
        pin: PIN,
        cookieName: COOKIE_NAME,
        cookieMaxAge,
        baseUrl: BASE_URL,
        nodeEnv: NODE_ENV,
        siteTitle: SITE_TITLE,
        buildVersion: BUILD_VERSION,
        highlightLanguages: HIGHLIGHT_LANGUAGES
    } = context;

    // Brute force protection
    const loginAttempts = new Map();
    const MAX_ATTEMPTS = process.env.MAX_ATTEMPTS || 5; // default to 5
    const LOCKOUT_TIME = process.env.LOCKOUT_TIME || 15; // default 15 minutes
    const lockOutTime = LOCKOUT_TIME * 60 * 1000; // in milliseconds

    // Reset attempts for an IP
    function resetAttempts(ip) {
        loginAttempts.delete(ip);
    }

    // Check if an IP is locked out
    function isLockedOut(ip) {
        const attempts = loginAttempts.get(ip);
        if (!attempts) return false;
        
        if (attempts.count >= MAX_ATTEMPTS) {
            const timeElapsed = Date.now() - attempts.lastAttempt;
            if (timeElapsed < lockOutTime) {
                return true;
            }
            resetAttempts(ip);
        }
        return false;
    }

    // Record an attempt for an IP
    function recordAttempt(ip) {
        const attempts = loginAttempts.get(ip) || { count: 0, lastAttempt: 0 };
        attempts.count += 1;
        attempts.lastAttempt = Date.now();
        loginAttempts.set(ip, attempts);
    }

    // Cleanup old lockouts periodically
    setInterval(() => {
        const now = Date.now();
        for (const [ip, attempts] of loginAttempts.entries()) {
            if (now - attempts.lastAttempt >= lockOutTime) {
                loginAttempts.delete(ip);
            }
        }
    }, 60000); // Clean up every minute

    // Validate PIN format
    function isValidPin(pin) {
        return typeof pin === 'string' && /^\d{4,10}$/.test(pin);
    }

    // Constant-time string comparison to prevent timing attacks
    function secureCompare(a, b) {
        if (typeof a !== 'string' || typeof b !== 'string') {
            return false;
        }
        
        // Use Node's built-in constant-time comparison
        try {
            return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
        } catch (err) {
            return false;
        }
    }

    // Main app route with PIN & CORS check
    app.get('/', originValidationMiddleware, (req, res) => {
        const pin = PIN;
        
        // Skip PIN if not configured
        if (!pin || !isValidPin(pin)) {
            return res.sendFile(path.join(publicDir, 'index.html'));
        }

        // Check PIN cookie
        const authCookie = req.cookies[COOKIE_NAME];
        if (!authCookie || !secureCompare(authCookie, pin)) {
            // Preserve the original URL with query parameters
            const originalUrl = req.originalUrl;
            const redirectParam = encodeURIComponent(originalUrl);
            return res.redirect(`/login?redirect=${redirectParam}`);
        }

        res.sendFile(path.join(publicDir, 'index.html'));
    });

    // Helper function to validate redirect URLs for security
    function isValidRedirectUrl(url) {
        if (!url || typeof url !== 'string') {
            return false;
        }
        
        // Must start with "/" (relative path)
        if (!url.startsWith('/')) {
            return false;
        }
        
        // Must not start with "//" (protocol-relative URL that could redirect externally)
        if (url.startsWith('//')) {
            return false;
        }
        
        // Must not contain backslashes (could be used for bypasses)
        if (url.includes('\\')) {
            return false;
        }
        
        // Must not contain encoded characters that could be used for bypasses
        if (url.includes('%2f') || url.includes('%2F') || url.includes('%5c') || url.includes('%5C')) {
            return false;
        }
        
        return true;
    }

    // Login page route
    app.get('/login', (req, res) => {
        // If no PIN is required or user is already authenticated, redirect to main app
        const pin = PIN;
        if (!pin || !isValidPin(pin) || (req.cookies[COOKIE_NAME] && secureCompare(req.cookies[COOKIE_NAME], pin))) {
            // If user is already authenticated, redirect to the original URL if provided
            const redirectParam = req.query.redirect;
            if (redirectParam) {
                const decodedRedirect = decodeURIComponent(redirectParam);
                if (isValidRedirectUrl(decodedRedirect)) {
                    return res.redirect(decodedRedirect);
                } else {
                    console.warn('Invalid redirect parameter blocked:', redirectParam);
                    return res.redirect('/');
                }
            }
            return res.redirect('/');
        }
        
        res.sendFile(path.join(publicDir, 'login.html'));
    });

    // Pin verification endpoint
    app.post('/api/verify-pin', (req, res) => {
        const { pin } = req.body;
        
        // If no PIN is set in env, always return success
        if (!PIN) {
            return res.json({ success: true });
        }

        const ip = getClientIp(req);
        
        // Security: Validate that we have a valid client IP for rate-limiting
        // Reject requests with null IPs to prevent shared rate-limit counter exploitation
        if (!ip) {
            console.error('Unable to determine client IP address for rate-limiting');
            return res.status(500).json({ error: 'Unable to determine client IP address' });
        }
        
        // Check if IP is locked out
        if (isLockedOut(ip)) {
            const attempts = loginAttempts.get(ip);
            const timeLeft = Math.ceil((lockOutTime - (Date.now() - attempts.lastAttempt)) / 1000 / 60);
            return res.status(429).json({ 
                error: `Too many attempts. Please try again in ${timeLeft} minute(s).`
            });
        }

        // Validate PIN format
        if (!isValidPin(pin)) {
            recordAttempt(ip);
            return res.status(400).json({ success: false, error: 'Invalid PIN format' });
        }

        // Verify the PIN using constant-time comparison
        if (pin && secureCompare(pin, PIN)) {
            // Reset attempts on successful login
            resetAttempts(ip);

            // Set secure HTTP-only cookie
            res.cookie(COOKIE_NAME, pin, {
                httpOnly: true,
                secure: req.secure || (BASE_URL.startsWith("https") && NODE_ENV === 'production'),
                sameSite: 'strict',
                maxAge: cookieMaxAge
            });
            res.json({ success: true });
        } else {
            // Record failed attempt
            recordAttempt(ip);
            
            const attempts = loginAttempts.get(ip);
            const attemptsLeft = MAX_ATTEMPTS - attempts.count;
            
            res.status(401).json({ 
                success: false, 
                error: 'Invalid PIN',
                attemptsLeft: Math.max(0, attemptsLeft)
            });
        }
    });

    // Check if PIN is required
    app.get('/api/pin-required', (req, res) => {
        const ip = getClientIp(req);
        
        // Security: Validate that we have a valid client IP for rate-limiting
        // If IP is null, fail-secure by treating the client as locked out
        if (!ip) {
            console.error('SECURITY: Unable to determine client IP address for /api/pin-required endpoint - treating as locked');
        }
        
        res.json({ 
            required: !!PIN && isValidPin(PIN),
            length: PIN ? PIN.length : 0,
            locked: ip ? isLockedOut(ip) : true
        });
    });

    // Get site configuration
    app.get('/api/config', (req, res) => {
        res.json({
            siteTitle: SITE_TITLE,
            baseUrl: process.env.BASE_URL,
            version: BUILD_VERSION,
            highlightLanguages: HIGHLIGHT_LANGUAGES,
        });
    });

    // Pin protection middleware
    const requirePin = (req, res, next) => {
        // Check for PIN in Authorization header first (for API calls)
        if (PIN) {
            const authHeader = req.headers.authorization;
            if (authHeader && authHeader.startsWith('Bearer ')) {
                const token = authHeader.substring(7);
                if (secureCompare(token, PIN)) {
                    return next();
                }
            }
        }

        if (!PIN || !isValidPin(PIN)) {

            return next();
        }

        const authCookie = req.cookies[COOKIE_NAME];
        if (!authCookie || !secureCompare(authCookie, PIN)) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        next();
    };

    // Apply pin protection to all /api routes except pin verification
    app.use('/api', (req, res, next) => {
        if (req.path === '/verify-pin' || req.path === '/pin-required' || req.path === '/config') {
            return next();
        }
        requirePin(req, res, next);
    });

}

module.exports = { registerAuthRoutes };
