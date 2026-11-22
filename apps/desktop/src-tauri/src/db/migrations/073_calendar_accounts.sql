CREATE TABLE IF NOT EXISTS calendar_accounts (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    email TEXT,
    created_at INTEGER NOT NULL,
    salt TEXT NOT NULL,
    refresh_token_ciphertext TEXT NOT NULL,
    linked_calendar_ids TEXT NOT NULL DEFAULT '[]'
);
