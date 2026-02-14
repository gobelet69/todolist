-- Global Authentication Database Schema
-- This database will be shared across ALL apps (todo, habits, etc.)
-- Run with: npx wrangler d1 create global-auth
-- Then: npx wrangler d1 execute global-auth --file=global-auth-schema.sql

-- Users table for authentication (shared across all apps)
CREATE TABLE IF NOT EXISTS users (
  username TEXT PRIMARY KEY,
  password TEXT NOT NULL,
  role TEXT DEFAULT 'user',
  created_at INTEGER NOT NULL
);

-- Sessions table for login management (shared across all apps)
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  role TEXT NOT NULL,
  expires INTEGER NOT NULL,
  FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires);
