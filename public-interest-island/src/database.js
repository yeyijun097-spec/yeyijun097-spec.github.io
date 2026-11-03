import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import session from "express-session";
import { DatabaseSync } from "node:sqlite";

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export function createDatabase(config) {
  const dataDir = path.resolve(config.storage.dataDir);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const databasePath = path.join(dataDir, "interest-island.sqlite");
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin', 'user')),
      disabled INTEGER NOT NULL DEFAULT 0,
      must_change_password INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      sid TEXT PRIMARY KEY,
      sess TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions(expires_at);
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      action TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS photo_complaint_tasks (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      status TEXT NOT NULL,
      queue_position INTEGER NOT NULL DEFAULT 0,
      original_name TEXT NOT NULL DEFAULT '',
      mime_type TEXT NOT NULL DEFAULT '',
      image_path TEXT NOT NULL DEFAULT '',
      login_screenshot_path TEXT NOT NULL DEFAULT '',
      form_screenshot_path TEXT NOT NULL DEFAULT '',
      ocr_text TEXT NOT NULL DEFAULT '',
      data_json TEXT NOT NULL DEFAULT '{}',
      error TEXT NOT NULL DEFAULT '',
      form_fingerprint TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY(owner_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS photo_tasks_owner_idx ON photo_complaint_tasks(owner_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS photo_tasks_expiry_idx ON photo_complaint_tasks(expires_at);
    CREATE TABLE IF NOT EXISTS photo_complaint_tokens (
      token_hash TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      form_fingerprint TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(task_id) REFERENCES photo_complaint_tasks(id) ON DELETE CASCADE
    );
  `);
  fs.chmodSync(databasePath, 0o600);
  migrateLegacyUsers(db, config.storage.legacyUsersFile, dataDir);
  ensureInitialAdmin(db);
  ensureAdminAccount(db);
  cleanupExpiredSessions(db);
  return {
    db,
    users: createUserRepository(db),
    sessionStore: new SqliteSessionStore(db),
    photoComplaints: createPhotoComplaintRepository(db),
    close: () => db.close()
  };
}

function createPhotoComplaintRepository(db) {
  const select = (id) => mapPhotoTask(db.prepare("SELECT * FROM photo_complaint_tasks WHERE id = ?").get(id));
  return {
    create(task) {
      db.prepare(`INSERT INTO photo_complaint_tasks
        (id, owner_id, status, queue_position, original_name, mime_type, image_path, data_json, created_at, updated_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(task.id, task.ownerId, task.status, task.queuePosition || 0, task.originalName || "", task.mimeType || "",
          task.imagePath || "", JSON.stringify(task.data || {}), task.createdAt, task.updatedAt, task.expiresAt);
      return select(task.id);
    },
    get(id) { return select(id); },
    list(ownerId, isAdmin = false) {
      const rows = isAdmin
        ? db.prepare("SELECT * FROM photo_complaint_tasks ORDER BY created_at DESC LIMIT 200").all()
        : db.prepare("SELECT * FROM photo_complaint_tasks WHERE owner_id = ? ORDER BY created_at DESC LIMIT 100").all(ownerId);
      return rows.map(mapPhotoTask);
    },
    update(id, patch) {
      const current = select(id); if (!current) return null;
      const next = { ...current, ...patch, data: patch.data === undefined ? current.data : patch.data, updatedAt: new Date().toISOString() };
      db.prepare(`UPDATE photo_complaint_tasks SET status=?, queue_position=?, image_path=?, login_screenshot_path=?,
        form_screenshot_path=?, ocr_text=?, data_json=?, error=?, form_fingerprint=?, updated_at=? WHERE id=?`)
        .run(next.status, next.queuePosition || 0, next.imagePath || "", next.loginScreenshotPath || "", next.formScreenshotPath || "",
          next.ocrText || "", JSON.stringify(next.data || {}), next.error || "", next.formFingerprint || "", next.updatedAt, id);
      return select(id);
    },
    remove(id) { return db.prepare("DELETE FROM photo_complaint_tasks WHERE id = ?").run(id).changes > 0; },
    expired(now = new Date().toISOString()) { return db.prepare("SELECT * FROM photo_complaint_tasks WHERE expires_at <= ?").all(now).map(mapPhotoTask); },
    createToken(value) {
      db.prepare(`INSERT INTO photo_complaint_tokens
        (token_hash, task_id, owner_id, form_fingerprint, expires_at, consumed_at, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)`)
        .run(value.tokenHash, value.taskId, value.ownerId, value.formFingerprint, value.expiresAt, value.createdAt);
    },
    consumeToken(tokenHash, taskId, ownerId, fingerprint, now = new Date().toISOString()) {
      const result = db.prepare(`UPDATE photo_complaint_tokens SET consumed_at=? WHERE token_hash=? AND task_id=? AND owner_id=?
        AND form_fingerprint=? AND consumed_at IS NULL AND expires_at>?`).run(now, tokenHash, taskId, ownerId, fingerprint, now);
      return result.changes === 1;
    }
  };
}

function mapPhotoTask(row) {
  if (!row) return null;
  let data = {}; try { data = JSON.parse(row.data_json || "{}"); } catch {}
  return { id: row.id, ownerId: row.owner_id, status: row.status, queuePosition: row.queue_position,
    originalName: row.original_name, mimeType: row.mime_type, imagePath: row.image_path,
    loginScreenshotPath: row.login_screenshot_path, formScreenshotPath: row.form_screenshot_path,
    ocrText: row.ocr_text, data, error: row.error, formFingerprint: row.form_fingerprint,
    createdAt: row.created_at, updatedAt: row.updated_at, expiresAt: row.expires_at };
}

export class SqliteSessionStore extends session.Store {
  constructor(db) {
    super();
    this.db = db;
  }

  get(sid, callback) {
    try {
      const row = this.db.prepare("SELECT sess, expires_at FROM sessions WHERE sid = ?").get(sid);
      if (!row || Number(row.expires_at) <= Date.now()) {
        if (row) this.db.prepare("DELETE FROM sessions WHERE sid = ?").run(sid);
        callback(null, null);
        return;
      }
      callback(null, JSON.parse(row.sess));
    } catch (error) {
      callback(error);
    }
  }

  set(sid, value, callback = () => {}) {
    try {
      const expiresAt = sessionExpiry(value);
      this.db.prepare(`
        INSERT INTO sessions (sid, sess, expires_at) VALUES (?, ?, ?)
        ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires_at = excluded.expires_at
      `).run(sid, JSON.stringify(value), expiresAt);
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  destroy(sid, callback = () => {}) {
    try {
      this.db.prepare("DELETE FROM sessions WHERE sid = ?").run(sid);
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  touch(sid, value, callback = () => {}) {
    try {
      this.db.prepare("UPDATE sessions SET expires_at = ? WHERE sid = ?").run(sessionExpiry(value), sid);
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  destroyUserSessions(userId) {
    const rows = this.db.prepare("SELECT sid, sess FROM sessions").all();
    const remove = this.db.prepare("DELETE FROM sessions WHERE sid = ?");
    for (const row of rows) {
      try {
        const value = JSON.parse(row.sess);
        if (value?.user?.id === userId) remove.run(row.sid);
      } catch {
        remove.run(row.sid);
      }
    }
  }
}

function createUserRepository(db) {
  const publicFields = `id, username, role, disabled, must_change_password, created_at, updated_at`;
  return {
    authenticate(username, password) {
      const row = db.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE").get(normalizeUsername(username));
      if (!row || row.disabled || !verifyPassword(password, row)) return null;
      return publicUser(row);
    },
    getById(id) {
      const row = db.prepare(`SELECT ${publicFields} FROM users WHERE id = ?`).get(id);
      return row ? publicUser(row) : null;
    },
    list() {
      return db.prepare(`SELECT ${publicFields} FROM users ORDER BY role ASC, username COLLATE NOCASE ASC`).all().map(publicUser);
    },
    create({ username, password, role = "user", mustChangePassword = true }) {
      const normalized = normalizeUsername(username);
      validateUsername(normalized);
      validatePassword(password);
      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      const { hash, salt } = hashPassword(password);
      db.prepare(`
        INSERT INTO users (id, username, password_hash, password_salt, role, disabled, must_change_password, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)
      `).run(id, normalized, hash, salt, normalizeRole(role), mustChangePassword ? 1 : 0, now, now);
      return this.getById(id);
    },
    setDisabled(id, disabled) {
      db.prepare("UPDATE users SET disabled = ?, updated_at = ? WHERE id = ?")
        .run(disabled ? 1 : 0, new Date().toISOString(), id);
      return this.getById(id);
    },
    setPassword(id, password, mustChangePassword = false) {
      validatePassword(password);
      const { hash, salt } = hashPassword(password);
      db.prepare(`
        UPDATE users SET password_hash = ?, password_salt = ?, must_change_password = ?, updated_at = ? WHERE id = ?
      `).run(hash, salt, mustChangePassword ? 1 : 0, new Date().toISOString(), id);
      return this.getById(id);
    },
    delete(id) {
      return db.prepare("DELETE FROM users WHERE id = ?").run(id).changes > 0;
    },
    countAdmins() {
      return Number(db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND disabled = 0").get().count);
    },
    audit(userId, action, detail = "") {
      db.prepare("INSERT INTO audit_log (user_id, action, detail, created_at) VALUES (?, ?, ?, ?)")
        .run(userId || null, String(action), String(detail).slice(0, 1000), new Date().toISOString());
    }
  };
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return { hash, salt };
}

function verifyPassword(password, record) {
  try {
    const expected = Buffer.from(record.password_hash || record.hash, "hex");
    const actual = crypto.scryptSync(String(password), record.password_salt || record.salt, expected.length);
    return expected.length > 0 && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function publicUser(row) {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    disabled: Boolean(row.disabled),
    mustChangePassword: Boolean(row.must_change_password),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function ensureInitialAdmin(db) {
  const count = Number(db.prepare("SELECT COUNT(*) AS count FROM users").get().count);
  if (count > 0) return;
  const password = crypto.randomBytes(12).toString("base64url");
  const repo = createUserRepository(db);
  repo.create({ username: "admin", password, role: "admin", mustChangePassword: true });
  console.log("=".repeat(60));
  console.log("[Auth] 已创建初始管理员：admin");
  console.log(`[Auth] 一次性初始密码：${password}`);
  console.log("[Auth] 首次登录必须修改密码。");
  console.log("=".repeat(60));
}

function ensureAdminAccount(db) {
  const adminCount = Number(db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'").get().count);
  if (adminCount > 0) return;
  const firstUser = db.prepare("SELECT id FROM users ORDER BY created_at ASC, username COLLATE NOCASE ASC LIMIT 1").get();
  if (!firstUser) return;
  db.prepare("UPDATE users SET role = 'admin', updated_at = ? WHERE id = ?")
    .run(new Date().toISOString(), firstUser.id);
  console.log("[Auth] 旧账号缺少管理员角色，已将最早创建的账号设为管理员。");
}

function migrateLegacyUsers(db, sourceFile, dataDir) {
  const resolved = path.resolve(sourceFile || "config/users.json");
  if (!fs.existsSync(resolved)) return;
  const count = Number(db.prepare("SELECT COUNT(*) AS count FROM users").get().count);
  if (count > 0) return;
  try {
    const legacy = JSON.parse(fs.readFileSync(resolved, "utf8"));
    const insert = db.prepare(`
      INSERT OR IGNORE INTO users
      (id, username, password_hash, password_salt, role, disabled, must_change_password, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)
    `);
    const now = new Date().toISOString();
    db.exec("BEGIN");
    for (const [username, record] of Object.entries(legacy || {})) {
      if (!record?.hash || !record?.salt) continue;
      insert.run(crypto.randomUUID(), normalizeUsername(username), record.hash, record.salt,
        normalizeRole(record.role), record.createdAt || now, now);
    }
    db.exec("COMMIT");
    const backupDir = path.join(dataDir, "migration-backup");
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    const backupPath = path.join(backupDir, `users-${Date.now()}.json`);
    fs.renameSync(resolved, backupPath);
    fs.chmodSync(backupPath, 0o600);
    console.log(`[Auth] 已迁移旧账号数据并保存受限备份：${backupPath}`);
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw new Error(`迁移旧账号失败：${error.message}`);
  }
}

function cleanupExpiredSessions(db) {
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now());
}

function sessionExpiry(value) {
  const expires = value?.cookie?.expires ? new Date(value.cookie.expires).getTime() : 0;
  return Number.isFinite(expires) && expires > Date.now() ? expires : Date.now() + SESSION_TTL_MS;
}

function normalizeUsername(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeRole(value) {
  return value === "admin" ? "admin" : "user";
}

function validateUsername(value) {
  if (!/^[a-z0-9._-]{3,40}$/.test(value)) {
    throw new Error("用户名需为3-40位小写字母、数字、点、下划线或短横线");
  }
}

function validatePassword(value) {
  const password = String(value || "");
  if (password.length < 10 || password.length > 128) {
    throw new Error("密码长度需为10-128位");
  }
}
