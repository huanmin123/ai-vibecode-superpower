import os
import pickle
import sqlite3
import threading

BASE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "uploads")
RESTORE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "restored")

_lock = threading.Lock()
_connection = None

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    email TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member'
);

CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY,
    owner_id INTEGER NOT NULL,
    reference TEXT NOT NULL,
    total_cents INTEGER NOT NULL,
    status TEXT NOT NULL,
    shipping_address TEXT NOT NULL
);
"""

USERS = [
    (1, "avery", "Avery Chen", "avery.chen@example.test", "admin"),
    (2, "alice", "Alice Park", "alice.park@example.test", "member"),
    (3, "bob", "Bob Ruiz", "bob.ruiz@example.test", "member"),
]

NOTES = [
    (2, "Q3 launch checklist", "Confirm pricing page copy and schedule the customer email."),
    (2, "Vendor renewal notes", "The design tool renewal is due next month."),
    (3, "Onboarding feedback", "New teammates want a shorter setup guide."),
]

ORDERS = [
    (1001, 2, "ORD-1001", 18900, "paid", "18 Market Street, Springfield"),
    (1002, 3, "ORD-1002", 4250, "processing", "77 Cedar Avenue, Riverton"),
]


def _initialize(conn):
    conn.executescript(SCHEMA)
    if conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]:
        return

    conn.executemany(
        "INSERT INTO users (id, username, display_name, email, role) VALUES (?, ?, ?, ?, ?)",
        USERS,
    )
    conn.executemany(
        "INSERT INTO notes (owner_id, title, body) VALUES (?, ?, ?)",
        NOTES,
    )
    conn.executemany(
        """
        INSERT INTO orders (id, owner_id, reference, total_cents, status, shipping_address)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        ORDERS,
    )
    conn.commit()


def get_connection():
    global _connection
    if _connection is None:
        with _lock:
            if _connection is None:
                conn = sqlite3.connect(":memory:", check_same_thread=False)
                conn.row_factory = sqlite3.Row
                _initialize(conn)
                _connection = conn
    return _connection


def fetch_all(sql, params=()):
    cursor = get_connection().execute(sql, params)
    return [dict(row) for row in cursor.fetchall()]


def fetch_one(sql, params=()):
    row = get_connection().execute(sql, params).fetchone()
    return dict(row) if row is not None else None


def get_user(user_id):
    return fetch_one(
        "SELECT id, username, display_name, email, role FROM users WHERE id = ?",
        (user_id,),
    )


def get_order(order_id):
    return fetch_one(
        """
        SELECT id, owner_id, reference, total_cents, status, shipping_address
        FROM orders
        WHERE id = ?
        """,
        (order_id,),
    )


def list_orders(owner_id):
    return fetch_all(
        "SELECT id, reference, total_cents, status FROM orders WHERE owner_id = ? ORDER BY id",
        (owner_id,),
    )


# Used by the offline cache warm-up script, not by the web process.
def load_cached_preferences(blob):
    return pickle.loads(blob)
