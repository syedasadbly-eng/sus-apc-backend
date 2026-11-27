/* ============================================
   SMART URBAN SENSING — Auth & Audit Module
   Real user accounts, JWT sessions, login audit log,
   and admin endpoints.
   ============================================
   Exposes a single `installAuth(app, db)` that:
     - Creates the users & login_events tables
     - Mounts /api/auth/* endpoints (login, logout, me, password)
     - Mounts /api/admin/users and /api/admin/login-events
     - Returns { requireAuth, requireAdmin } middleware so the host
       app can gate any other route it wants.
   ============================================ */

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');

const JWT_SECRET =
  process.env.AUTH_JWT_SECRET ||
  // Fallback: deterministic dev secret derived from the DB file path so it
  // survives restarts on the same machine. Production MUST set AUTH_JWT_SECRET.
  crypto.createHash('sha256').update('sus-apc-dev-' + (process.env.DB_PATH || 'default')).digest('hex');
const JWT_TTL_HOURS = Number(process.env.AUTH_JWT_TTL_HOURS) || 12;
const COOKIE_NAME = process.env.AUTH_COOKIE_NAME || 'sus_session';
const BCRYPT_ROUNDS = 12;

// In-production cookies should be Secure + SameSite=Lax. We default to that
// behind Railway's HTTPS proxy. Set AUTH_INSECURE_COOKIE=1 for plain-http dev.
const SECURE_COOKIE = process.env.AUTH_INSECURE_COOKIE ? false : true;

function installAuth(app, db) {
  // ---- Schema ----------------------------------------------------------
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      email         TEXT    NOT NULL UNIQUE COLLATE NOCASE,
      name          TEXT    NOT NULL DEFAULT '',
      password_hash TEXT    NOT NULL,
      role          TEXT    NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
      active        INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      last_login_at TEXT
    );

    CREATE TABLE IF NOT EXISTS login_events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
      email      TEXT    NOT NULL,
      login_at   TEXT    NOT NULL DEFAULT (datetime('now')),
      ip_address TEXT,
      user_agent TEXT,
      status     TEXT    NOT NULL CHECK (status IN ('success','failure')),
      reason     TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_login_events_login_at ON login_events(login_at DESC);
    CREATE INDEX IF NOT EXISTS idx_login_events_user_id  ON login_events(user_id);
    CREATE INDEX IF NOT EXISTS idx_login_events_status   ON login_events(status);
  `);

  // ---- Prepared statements --------------------------------------------
  const stmts = {
    findUserByEmail: db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE'),
    findUserById:    db.prepare('SELECT * FROM users WHERE id = ?'),
    touchLastLogin:  db.prepare('UPDATE users SET last_login_at = datetime(\'now\') WHERE id = ?'),
    insertEvent:     db.prepare(`
      INSERT INTO login_events (user_id, email, ip_address, user_agent, status, reason)
      VALUES (@user_id, @email, @ip_address, @user_agent, @status, @reason)
    `),
    listUsers:       db.prepare(`
      SELECT id, email, name, role, active, created_at, last_login_at
      FROM users ORDER BY created_at DESC
    `),
    insertUser:      db.prepare(`
      INSERT INTO users (email, name, password_hash, role, active)
      VALUES (@email, @name, @password_hash, @role, @active)
    `),
    updateUser:      db.prepare(`
      UPDATE users SET name = @name, role = @role, active = @active WHERE id = @id
    `),
    updatePassword:  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
    deleteUser:      db.prepare('DELETE FROM users WHERE id = ?'),
    countAdmins:     db.prepare('SELECT COUNT(*) AS n FROM users WHERE role = \'admin\' AND active = 1'),
  };

  // ---- Helpers ---------------------------------------------------------
  function sanitizeUser(u) {
    if (!u) return null;
    const { password_hash, ...rest } = u;
    return { ...rest, active: !!rest.active };
  }
  function clientIp(req) {
    const xf = req.headers['x-forwarded-for'];
    if (xf) return String(xf).split(',')[0].trim();
    return req.ip || req.connection?.remoteAddress || '';
  }
  function clientUA(req) {
    return String(req.headers['user-agent'] || '').slice(0, 500);
  }
  function recordEvent(opts) {
    try {
      stmts.insertEvent.run({
        user_id: opts.user_id || null,
        email: opts.email || '',
        ip_address: opts.ip_address || '',
        user_agent: opts.user_agent || '',
        status: opts.status,
        reason: opts.reason || null,
      });
    } catch (err) {
      console.error('[AUTH] Failed to record login event:', err.message);
    }
  }
  function signToken(user) {
    return jwt.sign(
      { sub: user.id, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: `${JWT_TTL_HOURS}h` }
    );
  }
  function setSessionCookie(res, token) {
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      secure: SECURE_COOKIE,
      sameSite: 'lax',
      maxAge: JWT_TTL_HOURS * 3600 * 1000,
      path: '/',
    });
  }
  function clearSessionCookie(res) {
    res.clearCookie(COOKIE_NAME, { path: '/' });
  }

  // ---- Middleware ------------------------------------------------------
  function requireAuth(req, res, next) {
    const token = req.cookies?.[COOKIE_NAME] ||
      (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')
        ? req.headers.authorization.slice(7)
        : null);
    if (!token) return res.status(401).json({ error: 'Authentication required' });
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      const user = stmts.findUserById.get(payload.sub);
      if (!user || !user.active) return res.status(401).json({ error: 'Session invalid' });
      req.user = sanitizeUser(user);
      next();
    } catch {
      return res.status(401).json({ error: 'Session invalid' });
    }
  }
  function requireAdmin(req, res, next) {
    requireAuth(req, res, () => {
      if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin required' });
      next();
    });
  }

  // ---- Express wiring --------------------------------------------------
  app.use(cookieParser());

  // POST /api/auth/login   { email, password }
  app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body || {};
    const ip = clientIp(req);
    const ua = clientUA(req);
    if (!email || !password) {
      recordEvent({ email: email || '', ip_address: ip, user_agent: ua, status: 'failure', reason: 'missing_fields' });
      return res.status(400).json({ error: 'Email and password are required' });
    }
    const user = stmts.findUserByEmail.get(String(email).trim());
    if (!user) {
      recordEvent({ email, ip_address: ip, user_agent: ua, status: 'failure', reason: 'unknown_user' });
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    if (!user.active) {
      recordEvent({ user_id: user.id, email: user.email, ip_address: ip, user_agent: ua, status: 'failure', reason: 'account_disabled' });
      return res.status(403).json({ error: 'Account disabled' });
    }
    let ok = false;
    try { ok = await bcrypt.compare(password, user.password_hash); } catch { ok = false; }
    if (!ok) {
      recordEvent({ user_id: user.id, email: user.email, ip_address: ip, user_agent: ua, status: 'failure', reason: 'bad_password' });
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    stmts.touchLastLogin.run(user.id);
    recordEvent({ user_id: user.id, email: user.email, ip_address: ip, user_agent: ua, status: 'success' });
    const token = signToken(user);
    setSessionCookie(res, token);
    res.json({ ok: true, user: sanitizeUser(user), token });
  });

  // POST /api/auth/logout
  app.post('/api/auth/logout', (req, res) => {
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  // GET /api/auth/me
  app.get('/api/auth/me', requireAuth, (req, res) => {
    res.json({ user: req.user });
  });

  // POST /api/auth/change-password { current, next }
  app.post('/api/auth/change-password', requireAuth, async (req, res) => {
    const { current, next: nextPwd } = req.body || {};
    if (!current || !nextPwd) return res.status(400).json({ error: 'Both current and next password are required' });
    if (String(nextPwd).length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
    const u = stmts.findUserById.get(req.user.id);
    const ok = await bcrypt.compare(current, u.password_hash);
    if (!ok) return res.status(401).json({ error: 'Current password is incorrect' });
    const hash = await bcrypt.hash(nextPwd, BCRYPT_ROUNDS);
    stmts.updatePassword.run(hash, u.id);
    res.json({ ok: true });
  });

  // ---- Admin endpoints -------------------------------------------------

  // GET /api/admin/users
  app.get('/api/admin/users', requireAdmin, (req, res) => {
    const rows = stmts.listUsers.all().map(u => ({ ...u, active: !!u.active }));
    res.json({ users: rows });
  });

  // POST /api/admin/users  { email, name, password, role }
  app.post('/api/admin/users', requireAdmin, async (req, res) => {
    const { email, name, password, role } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
    if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    const r = (role === 'admin') ? 'admin' : 'user';
    try {
      const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      const info = stmts.insertUser.run({
        email: String(email).trim(), name: String(name || '').trim(),
        password_hash: hash, role: r, active: 1,
      });
      const created = stmts.findUserById.get(info.lastInsertRowid);
      res.json({ ok: true, user: sanitizeUser(created) });
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) {
        return res.status(409).json({ error: 'A user with that email already exists' });
      }
      res.status(500).json({ error: err.message });
    }
  });

  // PUT /api/admin/users/:id   { name, role, active, password? }
  app.put('/api/admin/users/:id', requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    const target = stmts.findUserById.get(id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    const name = req.body?.name ?? target.name;
    const role = (req.body?.role === 'admin' || req.body?.role === 'user') ? req.body.role : target.role;
    const active = req.body?.active === undefined ? !!target.active : !!req.body.active;
    // Safety: don't allow the last active admin to be demoted or deactivated.
    if (target.role === 'admin' && target.active && (role !== 'admin' || !active)) {
      const { n } = stmts.countAdmins.get();
      if (n <= 1) return res.status(400).json({ error: 'Cannot demote or disable the last active admin' });
    }
    stmts.updateUser.run({ id, name, role, active: active ? 1 : 0 });
    if (req.body?.password) {
      if (String(req.body.password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
      const hash = await bcrypt.hash(req.body.password, BCRYPT_ROUNDS);
      stmts.updatePassword.run(hash, id);
    }
    res.json({ ok: true, user: sanitizeUser(stmts.findUserById.get(id)) });
  });

  // DELETE /api/admin/users/:id
  app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    if (id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account' });
    const target = stmts.findUserById.get(id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.role === 'admin') {
      const { n } = stmts.countAdmins.get();
      if (n <= 1) return res.status(400).json({ error: 'Cannot delete the last active admin' });
    }
    stmts.deleteUser.run(id);
    res.json({ ok: true });
  });

  // GET /api/admin/login-events
  //   ?from=YYYY-MM-DD  ?to=YYYY-MM-DD  ?user_id=N  ?email=...  ?status=success|failure
  //   ?limit=200  ?offset=0  ?format=csv
  app.get('/api/admin/login-events', requireAdmin, (req, res) => {
    const { from, to, user_id, email, status, format } = req.query;
    const where = [];
    const params = {};
    if (from)    { where.push('login_at >= @from'); params.from = `${from} 00:00:00`; }
    if (to)      { where.push('login_at <= @to');   params.to   = `${to} 23:59:59`; }
    if (user_id) { where.push('user_id = @user_id'); params.user_id = Number(user_id); }
    if (email)   { where.push('email LIKE @email');  params.email = `%${email}%`; }
    if (status === 'success' || status === 'failure') {
      where.push('status = @status'); params.status = status;
    }
    const limit  = Math.min(Math.max(Number(req.query.limit)  || 200, 1), 5000);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const sql = `
      SELECT e.id, e.user_id, e.email, e.login_at, e.ip_address, e.user_agent, e.status, e.reason,
             u.name AS user_name, u.role AS user_role
      FROM login_events e
      LEFT JOIN users u ON u.id = e.user_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY e.login_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
    const rows = db.prepare(sql).all(params);

    if (format === 'csv') {
      const headers = ['id','login_at','user_id','user_name','email','user_role','status','reason','ip_address','user_agent'];
      const escape = v => {
        if (v === null || v === undefined) return '';
        const s = String(v).replace(/"/g, '""');
        return /[",\n]/.test(s) ? `"${s}"` : s;
      };
      const csv = [headers.join(',')]
        .concat(rows.map(r => headers.map(h => escape(r[h])).join(',')))
        .join('\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="login-events-${new Date().toISOString().slice(0,10)}.csv"`);
      return res.send(csv);
    }

    res.json({ events: rows, limit, offset });
  });

  // GET /api/admin/login-events/summary  — quick counts for the dashboard
  app.get('/api/admin/login-events/summary', requireAdmin, (req, res) => {
    const since = req.query.since || new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const row = db.prepare(`
      SELECT
        SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) AS successes,
        SUM(CASE WHEN status='failure' THEN 1 ELSE 0 END) AS failures,
        COUNT(DISTINCT CASE WHEN status='success' THEN user_id END) AS unique_users
      FROM login_events
      WHERE login_at >= @since
    `).get({ since: `${since} 00:00:00` });
    res.json({ since, ...row });
  });

  return { requireAuth, requireAdmin };
}

module.exports = { installAuth };
