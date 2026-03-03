export const TraceDOQueries = {
    Schema: {
        CREATE_EVENTS: `
			CREATE TABLE IF NOT EXISTS trace_events (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				request_id TEXT NOT NULL,
				step TEXT NOT NULL,
				start_ms REAL NOT NULL,
				duration_ms REAL NOT NULL,
				parent TEXT,
				attributes TEXT,
				created_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_trace_events_request_id ON trace_events(request_id);
			CREATE INDEX IF NOT EXISTS idx_trace_events_created_at ON trace_events(created_at);
		`
    },
    Events: {
        INSERT: `INSERT INTO trace_events (request_id, step, start_ms, duration_ms, parent, attributes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        GET_BY_REQUEST: `SELECT request_id, step, start_ms, duration_ms, parent, attributes FROM trace_events WHERE request_id = ? ORDER BY start_ms ASC`,
        DELETE_OLDER_THAN: `DELETE FROM trace_events WHERE created_at < ?`
    }
};

export const PartitionDOQueries = {
    Schema: {
        CREATE_ITEMS: `
            CREATE TABLE IF NOT EXISTS items_v3 (
                id TEXT PRIMARY KEY,
                version INTEGER,
                value BLOB,
                deleted INTEGER DEFAULT 0
            );
        `
    },
    Items: {
        GET_LATEST: "SELECT value, deleted FROM items_v3 WHERE id = ?",
        INSERT: "INSERT OR REPLACE INTO items_v3 (id, version, value, deleted) VALUES (?, ?, ?, ?)"
    }
};
