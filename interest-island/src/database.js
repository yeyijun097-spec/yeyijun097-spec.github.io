import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import session from "express-session";
import { DatabaseSync } from "node:sqlite";

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_USERS = 5;
export const TASK_QUOTA_LIMITS = Object.freeze({
  overview: 15,
  pipeline: 3,
  photo: 15
});
export const TASK_QUOTA_GRANT_SIZE = 15;

export function createDatabase(config) {
  const dataDir = path.resolve(config.storage.dataDir);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const databasePath = path.join(dataDir, "interest-island.sqlite");
  const bootstrapPasswordPath = path.join(dataDir, "bootstrap-admin-password.json");
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
    CREATE TABLE IF NOT EXISTS daily_task_quotas (
      user_id TEXT NOT NULL,
      quota_date TEXT NOT NULL,
      task_type TEXT NOT NULL CHECK(task_type IN ('overview', 'pipeline', 'photo')),
      used_count INTEGER NOT NULL DEFAULT 0 CHECK(used_count >= 0),
      bonus_count INTEGER NOT NULL DEFAULT 0 CHECK(bonus_count >= 0),
      updated_at TEXT NOT NULL,
      PRIMARY KEY(user_id, quota_date, task_type),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
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
    CREATE TABLE IF NOT EXISTS pipeline_jobs (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      input_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL,
      stage TEXT NOT NULL DEFAULT '',
      progress INTEGER NOT NULL DEFAULT 0,
      lane_progress_json TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      updated_at TEXT NOT NULL,
      finished_at TEXT,
      exit_code INTEGER,
      result_path TEXT,
      state_path TEXT,
      error TEXT,
      logs_json TEXT NOT NULL DEFAULT '[]',
      login_prompts INTEGER NOT NULL DEFAULT 0,
      login_kind TEXT,
      login_pending INTEGER NOT NULL DEFAULT 0,
      login_screenshot_path TEXT NOT NULL DEFAULT '',
      FOREIGN KEY(owner_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS pipeline_jobs_owner_idx ON pipeline_jobs(owner_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS pipeline_jobs_created_idx ON pipeline_jobs(created_at DESC);
    CREATE TABLE IF NOT EXISTS pipeline_workbooks (
      stored_name TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      original_name TEXT NOT NULL DEFAULT '',
      file_path TEXT NOT NULL,
      file_size INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(owner_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS pipeline_workbooks_owner_idx
      ON pipeline_workbooks(owner_id, updated_at DESC);
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
  ensureInitialAdmin(db, bootstrapPasswordPath);
  ensureAdminAccount(db);
  cleanupExpiredSessions(db);
  return {
    db,
    users: createUserRepository(db, bootstrapPasswordPath),
    taskQuotas: createTaskQuotaRepository(db),
    sessionStore: new SqliteSessionStore(db),
    photoComplaints: createPhotoComplaintRepository(db),
    pipelineJobs: createPipelineJobRepository(db),
    pipelineWorkbooks: createPipelineWorkbookRepository(db),
    close: () => db.close()
  };
}

function createTaskQuotaRepository(db) {
  const select = db.prepare(`
    SELECT used_count, bonus_count
    FROM daily_task_quotas
    WHERE user_id = ? AND quota_date = ? AND task_type = ?
  `);
  const insertEmpty = db.prepare(`
    INSERT OR IGNORE INTO daily_task_quotas
    (user_id, quota_date, task_type, used_count, bonus_count, updated_at)
    VALUES (?, ?, ?, 0, 0, ?)
  `);
  const updateUsed = db.prepare(`
    UPDATE daily_task_quotas
    SET used_count = ?, updated_at = ?
    WHERE user_id = ? AND quota_date = ? AND task_type = ?
  `);
  const addBonus = db.prepare(`
    UPDATE daily_task_quotas
    SET bonus_count = bonus_count + ?, updated_at = ?
    WHERE user_id = ? AND quota_date = ? AND task_type = ?
  `);

  function status(userId, taskType, quotaDate = shanghaiDate()) {
    validateTaskType(taskType);
    const row = select.get(userId, quotaDate, taskType);
    const base = TASK_QUOTA_LIMITS[taskType];
    const used = Number(row?.used_count || 0);
    const bonus = Number(row?.bonus_count || 0);
    return { taskType, quotaDate, base, bonus, limit: base + bonus, used, remaining: Math.max(0, base + bonus - used) };
  }

  return {
    status,
    all(userId, quotaDate = shanghaiDate()) {
      return Object.fromEntries(Object.keys(TASK_QUOTA_LIMITS).map((taskType) => [
        taskType,
        status(userId, taskType, quotaDate)
      ]));
    },
    consume(userId, taskType, amount = 1, quotaDate = shanghaiDate()) {
      validateTaskType(taskType);
      validateQuotaAmount(amount);
      const now = new Date().toISOString();
      db.exec("BEGIN IMMEDIATE");
      try {
        insertEmpty.run(userId, quotaDate, taskType, now);
        const current = status(userId, taskType, quotaDate);
        if (current.used + amount > current.limit) {
          const error = new Error(`${taskQuotaLabel(taskType)}今日额度不足（已用${current.used}/${current.limit}）`);
          error.statusCode = 429;
          throw error;
        }
        updateUsed.run(current.used + amount, now, userId, quotaDate, taskType);
        db.exec("COMMIT");
        return status(userId, taskType, quotaDate);
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch {}
        throw error;
      }
    },
    refund(userId, taskType, amount = 1, quotaDate = shanghaiDate()) {
      validateTaskType(taskType);
      validateQuotaAmount(amount);
      const current = status(userId, taskType, quotaDate);
      if (!current.used) return current;
      updateUsed.run(Math.max(0, current.used - amount), new Date().toISOString(), userId, quotaDate, taskType);
      return status(userId, taskType, quotaDate);
    },
    grant(userId, taskType, amount = TASK_QUOTA_GRANT_SIZE, quotaDate = shanghaiDate()) {
      validateTaskType(taskType);
      validateQuotaAmount(amount);
      const now = new Date().toISOString();
      insertEmpty.run(userId, quotaDate, taskType, now);
      addBonus.run(amount, now, userId, quotaDate, taskType);
      return status(userId, taskType, quotaDate);
    }
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
    recoverable() {
      return db.prepare(`
        SELECT * FROM photo_complaint_tasks
        WHERE status IN ('queued', 'recognizing', 'review', 'filling', 'waiting_login', 'awaiting_confirmation')
        ORDER BY created_at ASC
      `).all().map(mapPhotoTask);
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

function createPipelineJobRepository(db) {
  const select = db.prepare("SELECT * FROM pipeline_jobs WHERE id = ?");
  const upsert = db.prepare(`
    INSERT INTO pipeline_jobs (
      id, owner_id, mode, input_json, status, stage, progress, lane_progress_json,
      created_at, started_at, updated_at, finished_at, exit_code, result_path,
      state_path, error, logs_json, login_prompts, login_kind, login_pending,
      login_screenshot_path
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      owner_id=excluded.owner_id,
      mode=excluded.mode,
      input_json=excluded.input_json,
      status=excluded.status,
      stage=excluded.stage,
      progress=excluded.progress,
      lane_progress_json=excluded.lane_progress_json,
      started_at=excluded.started_at,
      updated_at=excluded.updated_at,
      finished_at=excluded.finished_at,
      exit_code=excluded.exit_code,
      result_path=excluded.result_path,
      state_path=excluded.state_path,
      error=excluded.error,
      logs_json=excluded.logs_json,
      login_prompts=excluded.login_prompts,
      login_kind=excluded.login_kind,
      login_pending=excluded.login_pending,
      login_screenshot_path=excluded.login_screenshot_path
  `);

  return {
    save(job) {
      upsert.run(
        job.id,
        job.ownerId,
        job.mode,
        JSON.stringify(job.input || {}),
        job.status,
        job.stage || "",
        Number(job.progress || 0),
        job.laneProgress ? JSON.stringify(job.laneProgress) : null,
        job.createdAt,
        job.startedAt || null,
        job.updatedAt,
        job.finishedAt || null,
        job.exitCode ?? null,
        job.resultPath || null,
        job.statePath || null,
        job.error || null,
        JSON.stringify(job.logs || []),
        Number(job.loginPrompts || 0),
        job.loginKind || null,
        job.loginPending ? 1 : 0,
        job.loginScreenshotPath || ""
      );
      return mapPipelineJob(select.get(job.id));
    },
    get(id) {
      return mapPipelineJob(select.get(id));
    },
    listRecent(limit = 20) {
      const safeLimit = Math.max(1, Math.min(200, Number(limit) || 20));
      return db.prepare("SELECT * FROM pipeline_jobs ORDER BY created_at DESC LIMIT ?")
        .all(safeLimit)
        .map(mapPipelineJob);
    },
    prune(limit = 20) {
      const safeLimit = Math.max(1, Math.min(200, Number(limit) || 20));
      return db.prepare(`
        DELETE FROM pipeline_jobs
        WHERE id NOT IN (
          SELECT id FROM pipeline_jobs ORDER BY created_at DESC LIMIT ?
        )
      `).run(safeLimit).changes;
    }
  };
}

function mapPipelineJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    ownerId: row.owner_id,
    mode: row.mode,
    input: parseJson(row.input_json, {}),
    status: row.status,
    stage: row.stage,
    progress: Number(row.progress || 0),
    laneProgress: parseJson(row.lane_progress_json, null),
    createdAt: row.created_at,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
    exitCode: row.exit_code,
    resultPath: row.result_path,
    statePath: row.state_path,
    error: row.error,
    logs: parseJson(row.logs_json, []),
    loginPrompts: Number(row.login_prompts || 0),
    loginKind: row.login_kind,
    loginPending: Boolean(row.login_pending),
    loginScreenshotPath: row.login_screenshot_path
  };
}

function createPipelineWorkbookRepository(db) {
  const select = db.prepare("SELECT * FROM pipeline_workbooks WHERE stored_name = ?");
  const insert = db.prepare(`
    INSERT INTO pipeline_workbooks
      (stored_name, owner_id, original_name, file_path, file_size, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const update = db.prepare(`
    UPDATE pipeline_workbooks
    SET original_name = ?, file_path = ?, file_size = ?, updated_at = ?
    WHERE stored_name = ? AND owner_id = ?
  `);
  return {
    save(workbook) {
      const current = mapPipelineWorkbook(select.get(workbook.name));
      const now = workbook.modifiedAt || new Date().toISOString();
      if (current && current.ownerId !== workbook.ownerId) {
        const error = new Error("工作簿已归属于其他账号");
        error.statusCode = 409;
        throw error;
      }
      if (current) {
        update.run(
          workbook.originalName || current.originalName,
          workbook.path,
          Number(workbook.size || 0),
          now,
          workbook.name,
          workbook.ownerId
        );
      } else {
        insert.run(
          workbook.name,
          workbook.ownerId,
          workbook.originalName || workbook.name,
          workbook.path,
          Number(workbook.size || 0),
          now,
          now
        );
      }
      return mapPipelineWorkbook(select.get(workbook.name));
    },
    getOwned(name, ownerId) {
      return mapPipelineWorkbook(db.prepare(
        "SELECT * FROM pipeline_workbooks WHERE stored_name = ? AND owner_id = ?"
      ).get(name, ownerId));
    },
    listOwned(ownerId) {
      return db.prepare(
        "SELECT * FROM pipeline_workbooks WHERE owner_id = ? ORDER BY updated_at DESC LIMIT 200"
      ).all(ownerId).map(mapPipelineWorkbook);
    },
    listAll() {
      return db.prepare(
        "SELECT * FROM pipeline_workbooks ORDER BY updated_at DESC LIMIT 1000"
      ).all().map(mapPipelineWorkbook);
    },
    remove(name, ownerId) {
      return db.prepare(
        "DELETE FROM pipeline_workbooks WHERE stored_name = ? AND owner_id = ?"
      ).run(name, ownerId).changes > 0;
    }
  };
}

function mapPipelineWorkbook(row) {
  if (!row) return null;
  return {
    name: row.stored_name,
    ownerId: row.owner_id,
    originalName: row.original_name,
    path: row.file_path,
    size: Number(row.file_size || 0),
    modifiedAt: row.updated_at,
    createdAt: row.created_at
  };
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
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

function createUserRepository(db, bootstrapPasswordPath = "") {
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
      const currentCount = Number(db.prepare("SELECT COUNT(*) AS count FROM users").get().count);
      if (currentCount >= MAX_USERS) {
        const error = new Error(`账号总数不能超过${MAX_USERS}个（包含管理员账号）`);
        error.statusCode = 409;
        throw error;
      }
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
      if (!mustChangePassword) removeBootstrapPasswordForUser(bootstrapPasswordPath, id);
      return this.getById(id);
    },
    delete(id) {
      return db.prepare("DELETE FROM users WHERE id = ?").run(id).changes > 0;
    },
    countAdmins() {
      return Number(db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND disabled = 0").get().count);
    },
    countUsers() {
      return Number(db.prepare("SELECT COUNT(*) AS count FROM users").get().count);
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

function ensureInitialAdmin(db, bootstrapPasswordPath) {
  const count = Number(db.prepare("SELECT COUNT(*) AS count FROM users").get().count);
  if (count > 0) return;
  if (fs.existsSync(bootstrapPasswordPath)) {
    throw new Error(`初始管理员凭证文件已存在但用户库为空，请人工核查后再启动：${bootstrapPasswordPath}`);
  }
  const password = crypto.randomBytes(12).toString("base64url");
  const repo = createUserRepository(db, bootstrapPasswordPath);
  let user = null;
  db.exec("BEGIN");
  try {
    user = repo.create({ username: "admin", password, role: "admin", mustChangePassword: true });
    fs.writeFileSync(bootstrapPasswordPath, JSON.stringify({
      username: user.username,
      password,
      userId: user.id,
      createdAt: new Date().toISOString(),
      notice: "首次登录后必须立即修改密码；修改成功后本文件会自动删除。"
    }, null, 2), { encoding: "utf8", flag: "wx", mode: 0o600 });
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    if (user && fs.existsSync(bootstrapPasswordPath)) fs.rmSync(bootstrapPasswordPath, { force: true });
    throw error;
  }
  console.log(`[Auth] 已创建初始管理员，凭证已写入受限文件：${bootstrapPasswordPath}`);
  console.log("[Auth] 首次登录必须修改密码；修改成功后凭证文件会自动删除。");
}

function removeBootstrapPasswordForUser(filePath, userId) {
  if (!filePath || !fs.existsSync(filePath)) return;
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (value?.userId === userId) fs.rmSync(filePath);
  } catch (error) {
    console.warn(`[Auth] 初始管理员凭证文件清理失败，请人工删除：${filePath}（${error.message}）`);
  }
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

function validateTaskType(taskType) {
  if (!Object.hasOwn(TASK_QUOTA_LIMITS, taskType)) {
    const error = new Error("任务额度类型不正确");
    error.statusCode = 400;
    throw error;
  }
}

function validateQuotaAmount(amount) {
  if (!Number.isInteger(amount) || amount < 1 || amount > 1000) {
    const error = new Error("任务额度数量不正确");
    error.statusCode = 400;
    throw error;
  }
}

function taskQuotaLabel(taskType) {
  return {
    overview: "用户信息查询",
    pipeline: "敏感词批量处理",
    photo: "图片录单"
  }[taskType] || "任务";
}

function shanghaiDate(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(now);
}
