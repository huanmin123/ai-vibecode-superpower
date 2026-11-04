'use strict';

const Database = require('better-sqlite3');
const { DATABASE_FILE } = require('./config');

let connection;

const SEED_USERS = [
  {
    username: 'avery',
    displayName: 'Avery Chen',
    email: 'avery.chen@example.test',
    phone: '+1-202-555-0141',
    role: 'admin',
  },
  {
    username: 'alice',
    displayName: 'Alice Park',
    email: 'alice.park@example.test',
    phone: '+1-202-555-0142',
    role: 'member',
  },
  {
    username: 'bob',
    displayName: 'Bob Ruiz',
    email: 'bob.ruiz@example.test',
    phone: '+1-202-555-0143',
    role: 'member',
  },
];

const SEED_NOTES = [
  {
    owner: 'alice',
    title: 'Q3 launch checklist',
    body: 'Confirm pricing page copy, review analytics events, and schedule the customer email.',
  },
  {
    owner: 'alice',
    title: 'Vendor renewal notes',
    body: 'The design tool renewal is due next month. Finance asked for the updated seat count.',
  },
  {
    owner: 'bob',
    title: 'Onboarding feedback',
    body: 'New teammates want a shorter setup guide and a sample project that runs offline.',
  },
];

const SEED_AUDIT = [
  {
    actor: 'avery',
    action: 'note.export',
    target: 'note:2',
    detail: 'exported notes for finance review',
  },
  {
    actor: 'alice',
    action: 'note.update',
    target: 'note:1',
    detail: 'updated launch checklist',
  },
  {
    actor: 'bob',
    action: 'file.preview',
    target: 'file:onboarding.png',
    detail: 'opened preview from the workspace list',
  },
];

function initialize(conn) {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT,
      role TEXT NOT NULL DEFAULT 'member',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id INTEGER NOT NULL REFERENCES users(id),
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_id INTEGER NOT NULL REFERENCES users(id),
      action TEXT NOT NULL,
      target TEXT,
      detail TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_notes_owner ON notes(owner_id);
  `);

  const total = conn.prepare('SELECT COUNT(*) AS total FROM users').get().total;
  if (total > 0) {
    return;
  }

  const insertUser = conn.prepare(`
    INSERT INTO users (username, display_name, email, phone, role)
    VALUES (@username, @displayName, @email, @phone, @role)
  `);
  const insertNote = conn.prepare(`
    INSERT INTO notes (owner_id, title, body)
    VALUES (@ownerId, @title, @body)
  `);
  const insertAudit = conn.prepare(`
    INSERT INTO audit_log (actor_id, action, target, detail)
    VALUES (@actorId, @action, @target, @detail)
  `);

  const seed = conn.transaction(() => {
    const userIds = new Map();
    for (const user of SEED_USERS) {
      const info = insertUser.run(user);
      userIds.set(user.username, info.lastInsertRowid);
    }
    for (const note of SEED_NOTES) {
      insertNote.run({
        ownerId: userIds.get(note.owner),
        title: note.title,
        body: note.body,
      });
    }
    for (const entry of SEED_AUDIT) {
      insertAudit.run({
        actorId: userIds.get(entry.actor),
        action: entry.action,
        target: entry.target,
        detail: entry.detail,
      });
    }
  });

  seed();
}

function getConnection() {
  if (!connection) {
    connection = new Database(DATABASE_FILE);
    connection.pragma('journal_mode = WAL');
    connection.pragma('foreign_keys = ON');
    initialize(connection);
  }
  return connection;
}

function getUserById(id) {
  return getConnection()
    .prepare('SELECT id, username, display_name, email, phone, role, created_at FROM users WHERE id = ?')
    .get(id);
}

function getNoteForOwner(noteId, ownerId) {
  return getConnection()
    .prepare('SELECT id, owner_id, title, body, created_at, updated_at FROM notes WHERE id = ? AND owner_id = ?')
    .get(noteId, ownerId);
}

function updateNote(noteId, ownerId, changes) {
  const fields = [];
  const values = [];

  if (typeof changes.title === 'string') {
    fields.push('title = ?');
    values.push(changes.title);
  }
  if (typeof changes.body === 'string') {
    fields.push('body = ?');
    values.push(changes.body);
  }
  if (fields.length === 0) {
    return 0;
  }

  values.push(noteId, ownerId);
  return getConnection()
    .prepare(`UPDATE notes SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND owner_id = ?`)
    .run(...values).changes;
}

function listAuditEntries(limit) {
  return getConnection()
    .prepare(`
      SELECT a.id, a.action, a.target, a.detail, a.created_at, u.username AS actor
      FROM audit_log a
      JOIN users u ON u.id = a.actor_id
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT ?
    `)
    .all(limit);
}

// Helper kept for the legacy import script that still runs outside this service.
function findNotesByTitleFragment(fragment) {
  return getConnection()
    .prepare("SELECT id, title FROM notes WHERE title LIKE '%" + fragment + "%'")
    .all();
}

module.exports = {
  getConnection,
  getUserById,
  getNoteForOwner,
  updateNote,
  listAuditEntries,
};
