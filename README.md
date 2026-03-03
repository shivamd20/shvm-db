# shvm-db

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/shivamd20/shvm-db)

## Motivation

DynamoDB proves that a **simple API + brutal operational discipline** can scale to absurd throughput. What it hides, however, is *how* much of that power comes from partitioning, routing, and automation rather than any magical storage engine.

**shvm-db exists to demystify DynamoDB by rebuilding its core model from first principles**, using modern serverless primitives:

* Cloudflare Durable Objects for single-writer partitions
* SQLite as the per-partition storage engine
* A unified global Table Registry for multi-tenant table management

This is not about beating DynamoDB in production today. It is about:

* Proving the architecture is reproducible
* Understanding where the real bottlenecks are
* Building an extensible substrate for experimentation

---

## Goals

### Primary Goals

1. **Exact DynamoDB API compatibility**

   * `PutItem`, `GetItem`, `UpdateItem`, `DeleteItem`, `Query`, `Scan`
   * Same semantics, same constraints, same mental model

2. **Strong per-partition consistency**

   * Single-writer guarantee per partition key
   * Fully serialized writes

3. **Operational simplicity for MVP**

   * One partition == one Durable Object
   * One SQLite database per partition

4. **Observable performance characteristics**

   * Clear throughput and latency ceilings
   * Measurable tradeoffs

5. **Learning-first correctness**

   * Clarity > cleverness
   * Deterministic behavior

---

## Non-Goals (MVP)

The following are **explicitly excluded from MVP**:

* Global tables / multi-region active writes (Tables are global across the Cloudflare account, but inherently run in the region of the primary DO)
* Automatic partition splitting
* Secondary indexes (LSI / GSI) (See #Open Problems)
* Multi-item transactions
* Strong cross-partition consistency
* Hot partition mitigation
* Encryption at rest
* IAM-grade access control

If it smells like Spanner, it is out.

---

## API Compatibility Matrix

| DynamoDB Operation | Implemented? | Notes |
| :--- | :--- | :--- |
| `CreateTable` | ✅ Yes | Creates table in the global registry. Instantly active. |
| `DeleteTable` | ✅ Yes | Removes table metadata. Underlying DOs orphaned. |
| `ListTables` | ✅ Yes | Supports pagination (`Limit`, `ExclusiveStartTableName`). |
| `DescribeTable`| ✅ Yes | Returns schema metadata from the global registry. |
| `PutItem` | ✅ Yes | Full condition expression support. |
| `GetItem` | ✅ Yes | Consistent reads from Leader or eventually consistent from Replicas. |
| `UpdateItem` | ✅ Yes | Supports `AttributeUpdates` and `UpdateExpression` (partially). |
| `DeleteItem` | ✅ Yes | Full condition expression support. |
| `Query` | ❌ No | Planned future addition for Sort Key ranged queries. |
| `Scan` | ❌ No | Requires cross-partition aggregation. Excluded from MVP. |
| `BatchWriteItem` | ❌ No | Excluded from MVP. |

---

## Data Model

### Table Definition

* Table has:

  * Partition Key (PK)
  * Sort Key (SK, optional)

### Item

* Stored as:

  ```json
  {
    "PK": "...",
    "SK": "...",
    "attributes": { ... }
  }
  ```

---

## MVP Architecture

### Core Simplification (v3)

The system uses a **pure, deterministic routing architecture** to separate table orchestration from partition storage.

1.  **TableRegistryDO (The Global Registry)**:
    *   A single global DO (`global-registry`) that stores metadata for all tables.
    *   Ensures cross-account table uniqueness and handles `CreateTable` / `ListTables`.
    *   Fetched *once* by the worker isolate securely and cached, keeping it completely out of the hot path for item operations.

2.  **PartitionDO (The Data Plane)**:
    *   Maps deterministically to a `TableName + PartitionKey` hash slice.
    *   Owns exactly one SQLite database.
    *   Serves as the sole authority and storage executor for that partition.

> **One Partition Key → SHA-256 Hash → One PartitionDO (Storage Executor)**

There is:
*   No in-memory routing map
*   No control-plane lookup during item access
*   No background queues for data replication
*   SQLite as the **only read/write path** inside the PartitionDO.

This ensures strict API consistency, 0ms routing overhead, and eliminates premature internal queue-based replication complexity.

This ensures correctness, debuggability, and eliminates premature optimization.

---

## Durable Object Internals (Per Partition)

### Storage Model (MVP)

* Exactly one SQLite database per partition
* SQLite runs in WAL mode
* SQLite is the **source of truth**

A write-through Cloudflare Cache API layer (LRU) exists in the API Edge Gateway in front of SQLite for fast reads, completely bypassing the invocation of Durable Objects upon cache hits.

---

### SQLite Schema (v3)

```sql
CREATE TABLE items_v3 (
  id TEXT PRIMARY KEY,
  version INTEGER,
  value BLOB,
  deleted INTEGER DEFAULT 0
);
```

* `id` is the concatenated `pk#sk`
* `version` reserved for future OCC
* Single row lookups for `GetItem`

---

### Write Path (PutItem)

1.  **API Gateway**: Worker hashes `tableName + PK` → `PartitionDO ID`.
2.  **Action**: Worker forwards request payload and AST direct to **PartitionDO**.
3.  **Transaction**: DO evaluates condition expressions (if any).
4.  **Commit**: DO executes `INSERT OR REPLACE` into SQLite.
5.  **Ack**: Returns success to client.

Durability relies on SQLite WAL + Cloudflare Durable Object storage guarantees.

---

### Read Path (GetItem)

1.  **API Gateway**: Worker hashes `tableName + PK` → `PartitionDO ID`.
2.  **Cache Check**: Edge Worker checks Cloudflare Cache API (via `CacheManager`). If hit, returns instantly to client, without waking DO.
3.  **Action (Miss)**: Worker forwards request to **PartitionDO**.
4.  **Execution**: DO executes SQLite `SELECT` and returns. 
5.  **Return**: Worker catches DO response, uses `ctx.waitUntil` to populate Edge Cache, and returns to client.

This Edge-level Cache (GetItem: 5-minute TTL, schemas: 2-hour TTL) enforces strong consistency via synchronous write-throughs while minimizing DO compute overhead.

---

### Query (Range on Sort Key)

* Direct SQLite ordered range scan on `sk`
* Fully synchronous
* Pagination handled via SQLite cursor

---

## Routing Layer

### API Gateway

* DynamoDB-compatible HTTP surface
* Parses:

  * Table name
  * PK value

### Partition Resolver

```text
partition_id = hash(PK)
DurableObjectStub = getObject(partition_id)
```

In MVP:

* No rebalancing
* No movement
* Deterministic mapping

---

## Consistency Model

### MVP Guarantees

* **Strong consistency per partition key**
* Read-after-write within same partition

### Explicitly NOT Guaranteed

* Cross-partition consistency
* Global ordering

This mirrors DynamoDB.

---

## Fault Tolerance (MVP)

### Durable Object Crash

* SQLite file persists
* On restart:

  * Open SQLite
  * Continue serving traffic

No WAL replay logic beyond SQLite.

---

## Expected Performance (MVP)

### Per Partition (Single Durable Object)

| Metric           | Expected       |
| ---------------- | -------------- |
| Write latency    | 3–10 ms        |
| Read latency     | 2–8 ms         |
| Write throughput | 500–2k ops/sec |
| Read throughput  | 2k–10k ops/sec |

This reflects pure SQLite + Durable Object overhead.

---

## Cost Model (MVP)

The MVP cost model is intentionally simple and transparent. There are **no hidden background systems**.

### Cost Drivers

1. **Durable Object execution time**

   * Each request executes inside exactly one Durable Object
   * Single-threaded, short-lived CPU bursts

2. **Durable Object storage**

   * One SQLite file per partition
   * Size grows linearly with data volume

3. **Request count**

   * One API request → one Durable Object invocation

---

### Relative Cost Characteristics

| Component       | Cost Behavior                         |
| --------------- | ------------------------------------- |
| Writes          | CPU + SQLite I/O bound                |
| Reads           | Mostly CPU bound                      |
| Hot partitions  | Expensive due to serialized execution |
| Cold partitions | Cheap, pay-per-use                    |

---

### Cost Compared to DynamoDB

* No provisioned throughput
* No capacity planning
* No burst limits
* Costs scale with **actual usage**, not theoretical capacity

Tradeoff:

* You pay more CPU per request
* You save on unused capacity

---

### MVP Cost Expectations

For learning-scale workloads:

* Very low idle cost
* Cost dominated by active partitions

For production-scale workloads:

* Cost efficiency depends entirely on partition distribution
* Hot keys are expensive by design

------|---------|
| Write latency | 1–5 ms (local) |
| Read latency (hot) | < 1 ms |
| Read latency (cold) | 3–10 ms |
| Write throughput | 1k–5k ops/sec |
| Read throughput | 5k–20k ops/sec |

### System Throughput

> Linear in number of partitions

1000 partitions ≈ millions of ops/sec (theoretical)

---

## Observability

MVP Metrics:

* Per-partition QPS
* WAL size
* Flush lag
* SQLite write latency
* Durable Object restart count

---

## Benchmarking

Primary benchmark:

* YCSB (A, B, C workloads)

Compare against:

* DynamoDB
* Redis
* PostgreSQL (sharded)

---

## Failure Modes (Known)

* Hot partition = hard ceiling
* SQLite write serialization
* WAL growth under heavy write load
* No fast recovery beyond SQLite guarantees

These are intentional MVP constraints.

---

## Detailed Bottleneck Breakdown

When running `shvm-db` at high throughput, the system hits hard ceilings due to intentional architecture choices:

1. **Single-Threaded Execution**: Each Durable Object runs on a single JavaScript isolate. A "hot partition" (many writes to the same PK) forces all requests sequentially through the same single-threaded Event Loop.
2. **SQLite Lock Contention**: While SQLite is fast, every mutating request executes inside an `INSERT OR REPLACE`. During the commit phase, the lock prevents other async tasks in the DO from mutating the DB concurrently without serialization.
3. **Partition Boundary Cap**: Once a single hash slice receives more than ~1,000 requests per second, the DO will become CPU bound. This reflects DynamoDB's original 1,000 WCU / partition hard cap.

---

## Roadmap & Changelog

Please view [CHANGELOG.md](./CHANGELOG.md) for details on the v3 architecture overhaul and what changed since MVP.

For the list of future enhancements, upcoming architecture features, and difficult open problems you can contribute to, please see [ROADMAP.md](./ROADMAP.md).

---

## Open Problems / Contributing

This project is open-source because solving distributed systems problems is fun. The following represent the hardest "Open Problems" in the `shvm-db` architecture. PRs tackling these are highly welcome!

* **Partition Splitting**: Right now, partitions are static. Implement a mechanism to dynamically detect when a single `SubDO` exceeds a storage or compute threshold, bisect its Sort Key range, and spawn two new `SubDOs` without downtime.
* **Global Secondary Indexes (GSI)**: How do we project attributes from a Leader SubDO into a totally different Partition Key space reliably? We need an eventually consistent projection engine.
* **Cross-Partition Transactions**: Implement Two-Phase Commit (2PC) or an equivalent coordinator across multiple `PartitionDOs` to support DynamoDB's `TransactWriteItems` API.

---

## FAQ

**Q: Is this ready for production?**
A: **Absolutely not.** This is an experimental educational project designed to demystify how partitioned databases work. Do not store mission-critical data in this.

**Q: How does durability work without R2?**
A: In this MVP iteration, durability relies 100% on the Cloudflare Durable Object's attached persistent storage. Cloudflare provides strong guarantees on DO storage, but if the DO storage gets corrupted, there is no external WAL/R2 backup to replay from.

**Q: Why not use Cloudflare D1 instead of embedded SQLite?**
A: D1 doesn't (currently) offer the same per-partition single-writer isolation model required to replicate DynamoDB's exact semantics and test these specific bottlenecks. Embedding SQLite gives the Leader DO complete control over the transaction lifecycle.

---

## Why This Is Worth Building

Because once you finish this:

* DynamoDB stops feeling magical
* Distributed databases stop being abstract
* You gain intuition that books do not give

This is not a toy.
This is a **forge**.

The live site has a short [Why](https://db.shvm.in/why.html) page and an [experiment blog](https://db.shvm.in/blog.html) with the full journey and benchmark notes.
