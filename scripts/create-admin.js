#!/usr/bin/env node
/* ============================================
   create-admin.js — seed or reset an admin user
   ============================================
   Usage:
     node scripts/create-admin.js <email> <password> [name]
     # or via env vars:
     ADMIN_EMAIL=you@x.com ADMIN_PASSWORD=secret123 node scripts/create-admin.js

   Idempotent: if the user already exists, it's upgraded to admin/active and
   the password is reset to the value you supply.
   ============================================ */

const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'apc_data.db');
const email = (process.argv[2] || process.env.ADMIN_EMAIL || '').trim();
const password = process.argv[3] || process.env.ADMIN_PASSWORD || '';
const name = process.argv[4] || process.env.ADMIN_NAME || '';

if (!email || !password) {
  console.error('Usage: node scripts/create-admin.js <email> <password> [name]');
  console.error('   or set ADMIN_EMAIL and ADMIN_PASSWORD env vars.');
  process.exit(1);
}
if (password.length < 8) {
  console.error('Password must be at least 8 characters.');
  process.exit(1);
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Make sure schema exists (mirrors auth.js — safe to repeat).
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
`);

const hash = bcrypt.hashSync(password, 12);
const existing = db.prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE').get(email);
if (existing) {
  db.prepare('UPDATE users SET password_hash = ?, role = \'admin\', active = 1, name = COALESCE(NULLIF(?, \'\'), name) WHERE id = ?')
    .run(hash, name, existing.id);
  console.log(`Updated admin user: ${email} (id=${existing.id})`);
} else {
  const info = db.prepare('INSERT INTO users (email, name, password_hash, role, active) VALUES (?, ?, ?, \'admin\', 1)')
    .run(email, name, hash);
  console.log(`Created admin user: ${email} (id=${info.lastInsertRowid})`);
}

db.close();
