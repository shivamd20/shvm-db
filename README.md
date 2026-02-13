# shvm-db

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/shivamd20/shvm-db)

## Motivation

DynamoDB proves that a **simple API + brutal operational discipline** can scale to absurd throughput. What it hides, however, is *how* much of that power comes from partitioning, routing, and automation rather than any magical storage engine.

**shvm-db exists to demystify DynamoDB by rebuilding its core model from first principles**, using modern serverless primitives:

* Cloudflare Durable Objects for single-writer partitions
* SQLite as the per-partition storage engine
* Object storage (R2) as the durability and recovery backbone

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

* Global tables / multi-region active writes
* Automatic partition splitting
* Secondary indexes (LSI / GSI)
* Multi-item transactions
* Strong cross-partition consistency
* Hot partition mitigation
* Encryption at rest
* IAM-grade access control

If it smells like Spanner, it is out.

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

1.  **PartitionDO (The Orchestrator)**:
    *   Maps a Partition Key (PK) to a "logical partition".
    *   Does **NOT** store data.
    *   Maintains the `RoutingTable` (Leader ID, Replica IDs).
    *   Handles autoscaling decisions (spawning new replicas).

2.  **SubDO (The Data Plane)**:
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

4. **Object storage**

   * Not used in MVP

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

### Phase 6: Storage Engine Evolution

* Replace SQLite with LSM engine
* Compaction scheduling
* Columnar experiments

---

## Why This Is Worth Building

Because once you finish this:

* DynamoDB stops feeling magical
* Distributed databases stop being abstract
* You gain intuition that books do not give

This is not a toy.
This is a **forge**.
