// Package db provides the SQLite database layer for the Haven desktop app.
// Uses modernc.org/sqlite (pure Go, no CGO required) for portability.
package db

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

// Store is the application database. All persistent data (strategies, trades,
// finders, settings, markers, engine keys) lives here.
type Store struct {
	db *sql.DB
	mu sync.RWMutex
}

// Open opens (or creates) the SQLite database at the given path.
// The directory is created if it doesn't exist.
func Open(path string) (*Store, error) {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, fmt.Errorf("create data directory: %w", err)
	}

	db, err := sql.Open("sqlite", path+"?_journal_mode=WAL&_busy_timeout=5000&_foreign_keys=on")
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}
	db.SetMaxOpenConns(1) // SQLite serializes writes
	db.SetConnMaxLifetime(0)

	store := &Store{db: db}
	if err := store.migrate(); err != nil {
		db.Close()
		return nil, fmt.Errorf("migrate: %w", err)
	}

	return store, nil
}

// Close closes the database connection.
func (s *Store) Close() error {
	return s.db.Close()
}

// migrate creates tables if they don't exist.
func (s *Store) migrate() error {
	schema := `
	CREATE TABLE IF NOT EXISTS strategies (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		code TEXT NOT NULL,
		params TEXT NOT NULL DEFAULT '{}',
		symbol TEXT NOT NULL DEFAULT '',
		interval TEXT NOT NULL DEFAULT '1h',
		finder_id TEXT DEFAULT '',
		mode TEXT NOT NULL DEFAULT 'dry',
		version INTEGER NOT NULL DEFAULT 1,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	);

	CREATE TABLE IF NOT EXISTS strategy_versions (
		id TEXT PRIMARY KEY,
		strategy_id TEXT NOT NULL REFERENCES strategies(id) ON DELETE CASCADE,
		code TEXT NOT NULL,
		params TEXT NOT NULL DEFAULT '{}',
		version INTEGER NOT NULL,
		approved_live INTEGER NOT NULL DEFAULT 0,
		created_at TEXT NOT NULL
	);

	CREATE TABLE IF NOT EXISTS finders (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		code TEXT NOT NULL,
		params TEXT NOT NULL DEFAULT '{}',
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	);

	CREATE TABLE IF NOT EXISTS trades (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		strategy_id TEXT NOT NULL DEFAULT '',
		symbol TEXT NOT NULL,
		side TEXT NOT NULL,
		qty REAL NOT NULL,
		price REAL NOT NULL,
		usd REAL NOT NULL,
		fee_usd REAL NOT NULL DEFAULT 0,
		time INTEGER NOT NULL,
		mode TEXT NOT NULL DEFAULT 'dry',
		tx_hash TEXT NOT NULL DEFAULT '',
		created_at TEXT NOT NULL
	);

	CREATE TABLE IF NOT EXISTS markers (
		id TEXT PRIMARY KEY,
		strategy_id TEXT NOT NULL,
		symbol TEXT NOT NULL,
		condition_type TEXT NOT NULL,
		condition_value REAL NOT NULL DEFAULT 0,
		direction TEXT NOT NULL DEFAULT 'above',
		state TEXT NOT NULL DEFAULT 'active',
		claimed_by TEXT NOT NULL DEFAULT '',
		claimed_at INTEGER NOT NULL DEFAULT 0,
		created_at TEXT NOT NULL
	);

	CREATE TABLE IF NOT EXISTS engine_keys (
		id TEXT PRIMARY KEY,
		key_hash TEXT NOT NULL UNIQUE,
		name TEXT NOT NULL DEFAULT '',
		active INTEGER NOT NULL DEFAULT 1,
		created_at TEXT NOT NULL,
		revoked_at TEXT
	);

	CREATE TABLE IF NOT EXISTS settings (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL
	);

	CREATE TABLE IF NOT EXISTS candles (
		symbol TEXT NOT NULL,
		interval TEXT NOT NULL,
		time INTEGER NOT NULL,
		open REAL NOT NULL,
		high REAL NOT NULL,
		low REAL NOT NULL,
		close REAL NOT NULL,
		volume REAL NOT NULL,
		PRIMARY KEY (symbol, interval, time)
	);

	CREATE INDEX IF NOT EXISTS idx_trades_time ON trades(time);
	CREATE INDEX IF NOT EXISTS idx_trades_strategy ON trades(strategy_id);
	CREATE INDEX IF NOT EXISTS idx_candles_symbol_interval ON candles(symbol, interval);
	CREATE INDEX IF NOT EXISTS idx_markers_strategy ON markers(strategy_id);
	CREATE INDEX IF NOT EXISTS idx_markers_state ON markers(state);
	`

	_, err := s.db.Exec(schema)
	return err
}

// --- Strategy CRUD ---

// Strategy represents a saved trading strategy.
type Strategy struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	Code      string  `json:"code"`
	Params    string  `json:"params"`
	Symbol    string  `json:"symbol"`
	Interval  string  `json:"interval"`
	FinderID  string  `json:"finder_id"`
	Mode      string  `json:"mode"`
	Version   int     `json:"version"`
	CreatedAt string  `json:"created_at"`
	UpdatedAt string  `json:"updated_at"`
}

// CreateStrategy saves a new strategy.
func (s *Store) CreateStrategy(st *Strategy) error {
	now := time.Now().UTC().Format(time.RFC3339)
	st.CreatedAt = now
	st.UpdatedAt = now
	if st.Mode == "" {
		st.Mode = "dry"
	}
	if st.Version == 0 {
		st.Version = 1
	}
	_, err := s.db.Exec(
		`INSERT INTO strategies (id, name, code, params, symbol, interval, finder_id, mode, version, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		st.ID, st.Name, st.Code, st.Params, st.Symbol, st.Interval, st.FinderID, st.Mode, st.Version, st.CreatedAt, st.UpdatedAt,
	)
	return err
}

// UpdateStrategy updates an existing strategy.
func (s *Store) UpdateStrategy(st *Strategy) error {
	st.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	_, err := s.db.Exec(
		`UPDATE strategies SET name=?, code=?, params=?, symbol=?, interval=?, finder_id=?, mode=?, version=?, updated_at=?
		 WHERE id=?`,
		st.Name, st.Code, st.Params, st.Symbol, st.Interval, st.FinderID, st.Mode, st.Version, st.UpdatedAt, st.ID,
	)
	return err
}

// GetStrategy retrieves a strategy by ID.
func (s *Store) GetStrategy(id string) (*Strategy, error) {
	row := s.db.QueryRow(
		`SELECT id, name, code, params, symbol, interval, finder_id, mode, version, created_at, updated_at
		 FROM strategies WHERE id=?`, id,
	)
	return scanStrategy(row)
}

// ListStrategies returns all strategies.
func (s *Store) ListStrategies() ([]Strategy, error) {
	rows, err := s.db.Query(
		`SELECT id, name, code, params, symbol, interval, finder_id, mode, version, created_at, updated_at
		 FROM strategies ORDER BY updated_at DESC`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var strategies []Strategy
	for rows.Next() {
		st, err := scanStrategyFromRows(rows)
		if err != nil {
			return nil, err
		}
		strategies = append(strategies, *st)
	}
	return strategies, rows.Err()
}

// DeleteStrategy removes a strategy by ID.
func (s *Store) DeleteStrategy(id string) error {
	_, err := s.db.Exec(`DELETE FROM strategies WHERE id=?`, id)
	return err
}

// --- Finder CRUD ---

// Finder represents a saved token finder.
type Finder struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Code      string `json:"code"`
	Params    string `json:"params"`
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
}

// CreateFinder saves a new finder.
func (s *Store) CreateFinder(f *Finder) error {
	now := time.Now().UTC().Format(time.RFC3339)
	f.CreatedAt = now
	f.UpdatedAt = now
	_, err := s.db.Exec(
		`INSERT INTO finders (id, name, code, params, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
		f.ID, f.Name, f.Code, f.Params, f.CreatedAt, f.UpdatedAt,
	)
	return err
}

// ListFinders returns all finders.
func (s *Store) ListFinders() ([]Finder, error) {
	rows, err := s.db.Query(`SELECT id, name, code, params, created_at, updated_at FROM finders ORDER BY updated_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var finders []Finder
	for rows.Next() {
		var f Finder
		if err := rows.Scan(&f.ID, &f.Name, &f.Code, &f.Params, &f.CreatedAt, &f.UpdatedAt); err != nil {
			return nil, err
		}
		finders = append(finders, f)
	}
	return finders, rows.Err()
}

// DeleteFinder removes a finder.
func (s *Store) DeleteFinder(id string) error {
	_, err := s.db.Exec(`DELETE FROM finders WHERE id=?`, id)
	return err
}

// --- Trade CRUD ---

// TradeRecord is a saved trade.
type TradeRecord struct {
	ID         int64   `json:"id"`
	StrategyID string  `json:"strategy_id"`
	Symbol     string  `json:"symbol"`
	Side       string  `json:"side"`
	Qty        float64 `json:"qty"`
	Price      float64 `json:"price"`
	Usd        float64 `json:"usd"`
	FeeUsd     float64 `json:"fee_usd"`
	Time       int64   `json:"time"`
	Mode       string  `json:"mode"`
	TxHash     string  `json:"tx_hash"`
	CreatedAt  string  `json:"created_at"`
}

// SaveTrade records a trade.
func (s *Store) SaveTrade(tr *TradeRecord) (int64, error) {
	tr.CreatedAt = time.Now().UTC().Format(time.RFC3339)
	result, err := s.db.Exec(
		`INSERT INTO trades (strategy_id, symbol, side, qty, price, usd, fee_usd, time, mode, tx_hash, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		tr.StrategyID, tr.Symbol, tr.Side, tr.Qty, tr.Price, tr.Usd, tr.FeeUsd, tr.Time, tr.Mode, tr.TxHash, tr.CreatedAt,
	)
	if err != nil {
		return 0, err
	}
	return result.LastInsertId()
}

// ListTrades returns trades, optionally filtered.
func (s *Store) ListTrades(strategyID string, limit int) ([]TradeRecord, error) {
	var rows *sql.Rows
	var err error
	if strategyID != "" {
		rows, err = s.db.Query(
			`SELECT id, strategy_id, symbol, side, qty, price, usd, fee_usd, time, mode, tx_hash, created_at
			 FROM trades WHERE strategy_id=? ORDER BY time DESC LIMIT ?`, strategyID, limit,
		)
	} else {
		rows, err = s.db.Query(
			`SELECT id, strategy_id, symbol, side, qty, price, usd, fee_usd, time, mode, tx_hash, created_at
			 FROM trades ORDER BY time DESC LIMIT ?`, limit,
		)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var trades []TradeRecord
	for rows.Next() {
		var tr TradeRecord
		if err := rows.Scan(&tr.ID, &tr.StrategyID, &tr.Symbol, &tr.Side, &tr.Qty, &tr.Price, &tr.Usd, &tr.FeeUsd, &tr.Time, &tr.Mode, &tr.TxHash, &tr.CreatedAt); err != nil {
			return nil, err
		}
		trades = append(trades, tr)
	}
	return trades, rows.Err()
}

// --- Settings ---

// GetSetting retrieves a setting value.
func (s *Store) GetSetting(key string) (string, error) {
	var value string
	err := s.db.QueryRow(`SELECT value FROM settings WHERE key=?`, key).Scan(&value)
	if err == sql.ErrNoRows {
		return "", nil
	}
	return value, err
}

// SetSetting stores a setting value.
func (s *Store) SetSetting(key, value string) error {
	_, err := s.db.Exec(
		`INSERT INTO settings (key, value) VALUES (?, ?)
		 ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
		key, value,
	)
	return err
}

// --- Candle storage ---

// Candle is a stored OHLCV bar.
type Candle struct {
	Symbol   string
	Interval string
	Time     int64
	Open     float64
	High     float64
	Low      float64
	Close    float64
	Volume   float64
}

// SaveCandles bulk-inserts candles.
func (s *Store) SaveCandles(candles []Candle) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	stmt, err := tx.Prepare(
		`INSERT OR REPLACE INTO candles (symbol, interval, time, open, high, low, close, volume)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
	)
	if err != nil {
		return err
	}
	defer stmt.Close()

	for _, c := range candles {
		if _, err := stmt.Exec(c.Symbol, c.Interval, c.Time, c.Open, c.High, c.Low, c.Close, c.Volume); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// GetCandles retrieves stored candles for a symbol and interval.
func (s *Store) GetCandles(symbol, interval string, limit int) ([]Candle, error) {
	rows, err := s.db.Query(
		`SELECT symbol, interval, time, open, high, low, close, volume
		 FROM candles WHERE symbol=? AND interval=? ORDER BY time DESC LIMIT ?`,
		symbol, interval, limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var candles []Candle
	for rows.Next() {
		var c Candle
		if err := rows.Scan(&c.Symbol, &c.Interval, &c.Time, &c.Open, &c.High, &c.Low, &c.Close, &c.Volume); err != nil {
			return nil, err
		}
		candles = append(candles, c)
	}
	// Reverse to chronological order
	for i, j := 0, len(candles)-1; i < j; i, j = i+1, j-1 {
		candles[i], candles[j] = candles[j], candles[i]
	}
	return candles, rows.Err()
}

func scanStrategy(row *sql.Row) (*Strategy, error) {
	var st Strategy
	err := row.Scan(&st.ID, &st.Name, &st.Code, &st.Params, &st.Symbol, &st.Interval, &st.FinderID, &st.Mode, &st.Version, &st.CreatedAt, &st.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return &st, nil
}

func scanStrategyFromRows(rows *sql.Rows) (*Strategy, error) {
	var st Strategy
	err := rows.Scan(&st.ID, &st.Name, &st.Code, &st.Params, &st.Symbol, &st.Interval, &st.FinderID, &st.Mode, &st.Version, &st.CreatedAt, &st.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return &st, nil
}
