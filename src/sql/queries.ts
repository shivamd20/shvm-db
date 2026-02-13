export const SubDOQueries = {
    Schema: {
        CREATE_METADATA: `
            CREATE TABLE IF NOT EXISTS metadata (
                key TEXT PRIMARY KEY,
                value TEXT
            );
        `,
        CREATE_ITEMS: `
            CREATE TABLE IF NOT EXISTS items_v2 (
                sk TEXT,
                version INTEGER,
                value BLOB,
                deleted INTEGER DEFAULT 0,
                PRIMARY KEY (sk, version DESC)
            );
        `,
        CREATE_CURSORS: `
            CREATE TABLE IF NOT EXISTS cursors (
                id TEXT PRIMARY KEY,
                val INTEGER
            );
        `
    },
    Metadata: {
        GET: "SELECT value FROM metadata WHERE key = ?",
        SET: "INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)"
    },
    Cursors: {
        GET: "SELECT val FROM cursors WHERE id = ?",
        SET: "INSERT OR REPLACE INTO cursors (id, val) VALUES (?, ?)",
        INIT_SEQ: "INSERT OR IGNORE INTO cursors (id, val) VALUES ('global_seq', 0)",
        INC_SEQ: "UPDATE cursors SET val = val + 1 WHERE id = 'global_seq'",
        GET_SEQ: "SELECT val FROM cursors WHERE id = 'global_seq'"
    },
    Items: {
        GET_LATEST: "SELECT value, deleted FROM items_v2 WHERE sk = ? ORDER BY version DESC LIMIT 1",
        INSERT: "INSERT INTO items_v2 (sk, version, value, deleted) VALUES (?, ?, ?, ?)",
        GET_HISTORY: `
            SELECT sk, version, value, deleted FROM items_v2 
            WHERE version > ? AND version <= ? 
            ORDER BY version ASC
        `
    }
};

export const PartitionDOQueries = {
    Schema: {
        CREATE_REPLICAS: `
            CREATE TABLE IF NOT EXISTS replicas (
                id TEXT PRIMARY KEY,
                state TEXT,
                last_seen INTEGER
            );
        `
    },
    Replicas: {
        REGISTER: `
            INSERT OR REPLACE INTO replicas (id, state, last_seen) 
            VALUES (?, ?, ?)
        `,
        DEREGISTER: "DELETE FROM replicas WHERE id = ?",
        GET_READABLE: "SELECT id FROM replicas WHERE state = ?",
        COUNT_READABLE: "SELECT count(*) as count FROM replicas WHERE state = ?",
        LIST_ALL: "SELECT id, state, last_seen FROM replicas"
    }
};
