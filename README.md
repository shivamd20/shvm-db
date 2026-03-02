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

### Core Simplification (Revised)

The system uses a **Two-Layer Architecture** to separate orchestration from storage.

1.  **TableRegistryDO (The Global Registry)**:
    *   A single global DO (`global-registry`) that stores metadata for all tables.
    *   Ensures cross-account table uniqueness and handles `CreateTable` / `ListTables`.

2.  **PartitionDO (The Orchestrator)**:
    *   Maps a Partition Key (PK) to a "logical partition".
    *   Does **NOT** store data.
    *   Maintains the `RoutingTable` (Leader ID, Replica IDs).
    *   Handles autoscaling decisions (spawning new replicas).

3.  **SubDO (The Data Plane)**:
    *   Where the actual data lives.
    *   **Leader SubDO**: Handles all writes for a PK. Serializes transactions.
    *   **Replica SubDOs**: Read-only copies that tail the Leader via queue.
    *   Each SubDO owns one SQLite database.

> **One Partition Key → One PartitionDO (Orchestrator) → N SubDOs (Storage)**

There is:
*   No in-memory hashmap (Routing is calculated hash + DO lookup)
*   No Bloom filter
*   SQLite as the **only read/write path** inside SubDOs.

This ensures correctness, debuggability, and eliminates premature optimization.

---

## Durable Object Internals (Per Partition)

### Storage Model (MVP)

* Exactly one SQLite database per partition
* SQLite runs in WAL mode
* SQLite is the **source of truth**

No auxiliary caches or layers exist in MVP.

---

### SQLite Schema (MVP)

````sql
CREATE TABLE items (
  sk TEXT PRIMARY KEY,
  value BLOB
);

CREATE INDEX idx_sk ON items(sk);
```sql
CREATE TABLE items (
  sk TEXT PRIMARY KEY,
  value BLOB,
  version INTEGER
);

CREATE INDEX idx_sk ON items(sk);
````

* Sorted by `SK`
* `version` reserved for future OCC

---

### Write Path (PutItem)

1.  **Router**: Hashes PK → determines `PartitionDO` ID.
2.  **Orchestration**: Checks `PartitionDO` (cached) for the current **Leader SubDO** ID.
3.  **Action**: Forwards request to **Leader SubDO**.
4.  **Transaction**: Leader begins SQLite transaction.
5.  **Commit**: `INSERT OR REPLACE` item.
6.  **Replication**: Leader enqueues mutation to `ReplicationQueue` (for Standby/Replicas).
7.  **Ack**: Returns success to client.

Durability relies on SQLite WAL + Cloudflare Queue guarantees.

---

### Read Path (GetItem)

1.  **Router**: Hashes PK → `PartitionDO`.
2.  **Orchestration**: Fetches `RoutingTable` (list of active Replicas).
3.  **Selection**: Randomly selects a **Replica SubDO** (or Leader if no replicas).
4.  **Action**: Forwards request to selected SubDO.
5.  **Execution**: SubDO executes SQLite `SELECT`.
6.  **Return**: Result returned to client.

No caching, no overlays. Just routing and SQLite.

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

When running `shvm-db` at high throughput, the system hits hard ceilings due to the intentional MVP constraints and the underlying Cloudflare Workers runtime. Here is exactly why the limits exist:

1. **Single-Threaded Execution**: Each Durable Object runs on a single JavaScript isolate. A "hot partition" (many writes to the same PK) forces all requests sequentially through the same single-threaded Event Loop.
2. **SQLite Lock Contention**: While SQLite is fast, every `PutItem` or `UpdateItem` executes inside a SQLite transaction. During the commit phase, the lock prevents other async tasks in the DO from mutating the DB. 
3. **RPC Overhead**: The architecture relies on jumping boundaries: `Worker -> PartitionDO -> SubDO Leader`. Each boundary hop adds latency (usually ~1-2ms), meaning a single operation has a baseline floor it cannot dip below.
4. **Queue Replication Lag**: Standard Cloudflare Queues are used to replicate data from Leader to Replicas. Under massive load, the queue delivery can back up, increasing replica lag to several seconds instead of milliseconds.

---

## Roadmap / Future Work

### Phase 0.5: WAL Offload (Next Immediate Step)

* External write-ahead log in object storage
* Faster acknowledgements
* Crash replay independent of SQLite

### Phase 2: Partition Scaling

* Sort-key range splitting
* Dual-writes during migration
* Router updates

### Phase 3: Indexes

* LSI via same SQLite
* GSI via separate Durable Objects

### Phase 4: Replication

* Multi-region WAL replication
* Read replicas
* Eventually consistent global tables

### Phase 5: Transactions

* Two-phase commit (best effort)
* Partition-scoped transactions first

### Phase 5: Storage Engine Evolution

* Replace SQLite with LSM engine
* Compaction scheduling
* Columnar experiments

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
