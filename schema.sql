-- Todo List Data Database Schema for Cloudflare D1
-- This database contains ONLY todo-specific data
-- Authentication is handled by the global-auth database
-- Run with: npx wrangler d1 execute todolist-data --file=schema.sql

-- Boards table (each user can have multiple boards)
CREATE TABLE IF NOT EXISTS boards (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
);

-- Lists table (columns like "To Do", "Doing", "Done")
CREATE TABLE IF NOT EXISTS lists (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL,
  username TEXT NOT NULL,
  name TEXT NOT NULL,
  position INTEGER NOT NULL,
  color TEXT DEFAULT '#bb86fc',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE CASCADE,
  FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
);

-- Cards table (individual tasks)
CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY,
  list_id TEXT NOT NULL,
  board_id TEXT NOT NULL,
  username TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  position INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (list_id) REFERENCES lists(id) ON DELETE CASCADE,
  FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE CASCADE,
  FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_boards_username ON boards(username);
CREATE INDEX IF NOT EXISTS idx_lists_board ON lists(board_id);
CREATE INDEX IF NOT EXISTS idx_cards_list ON cards(list_id);
CREATE INDEX IF NOT EXISTS idx_cards_board ON cards(board_id);

-- Blocus calendar boards (study planning periods)
CREATE TABLE IF NOT EXISTS blocus_boards (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  name TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
);

-- Courses attached to a blocus board (pastel color per course)
CREATE TABLE IF NOT EXISTS blocus_courses (
  id TEXT PRIMARY KEY,
  blocus_id TEXT NOT NULL,
  username TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  position INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (blocus_id) REFERENCES blocus_boards(id) ON DELETE CASCADE,
  FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
);

-- Optional exam subsections for a course (e.g. written/oral/final)
CREATE TABLE IF NOT EXISTS blocus_course_sections (
  id TEXT PRIMARY KEY,
  blocus_id TEXT NOT NULL,
  course_id TEXT NOT NULL,
  username TEXT NOT NULL,
  name TEXT NOT NULL,
  position INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (blocus_id) REFERENCES blocus_boards(id) ON DELETE CASCADE,
  FOREIGN KEY (course_id) REFERENCES blocus_courses(id) ON DELETE CASCADE,
  FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
);

-- Daily slot assignments (morning/afternoon)
CREATE TABLE IF NOT EXISTS blocus_slots (
  id TEXT PRIMARY KEY,
  blocus_id TEXT NOT NULL,
  username TEXT NOT NULL,
  day TEXT NOT NULL,
  period TEXT NOT NULL CHECK (period IN ('morning', 'afternoon')),
  course_id TEXT,
  section_id TEXT,
  is_exam INTEGER NOT NULL DEFAULT 0,
  exam_note TEXT DEFAULT '',
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (blocus_id) REFERENCES blocus_boards(id) ON DELETE CASCADE,
  FOREIGN KEY (course_id) REFERENCES blocus_courses(id) ON DELETE SET NULL,
  FOREIGN KEY (section_id) REFERENCES blocus_course_sections(id) ON DELETE SET NULL,
  FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE,
  UNIQUE (blocus_id, day, period)
);

CREATE INDEX IF NOT EXISTS idx_blocus_boards_username ON blocus_boards(username);
CREATE INDEX IF NOT EXISTS idx_blocus_courses_board ON blocus_courses(blocus_id);
CREATE INDEX IF NOT EXISTS idx_blocus_sections_course ON blocus_course_sections(course_id);
CREATE INDEX IF NOT EXISTS idx_blocus_slots_board_day ON blocus_slots(blocus_id, day);
