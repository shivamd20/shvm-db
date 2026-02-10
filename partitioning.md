# Partitioned Durable Object Storage System

## 1. Motivation

We want a globally distributed, high-throughput key-value / sorted-key store with:

* Predictable write correctness
* Very fast global reads
* Strong isolation between tenants / partitions
* Clear, explicit consistency semantics

The goal is **not** to build a DynamoDB clone, but to understand and deliberately choose the same architectural trade-offs that make systems like DynamoDB scale, while keeping the system honest, explicit, and evolvable.

Early naive designs (one DB per partition) revealed hard ceilings around:

* hot partitions
* single-threaded orchestration
* fsync-bound writes

This document explains how we evolved from that naive model to a design that scales reads globally and writes safely, and why each trade-off was made.

---

## 2. Non-Goals

To keep scope disciplined, the system explicitly does NOT aim to provide:

* Cross-partition transactions
* Multi-key atomicity across sub-partitions
* Strongly consistent global scans
* Automatic infinite scaling guarantees

These are consciously excluded because they multiply complexity and hide real costs.

---

## 3. Key Observations That Drove the Design

### Observation 1: Data size does not determine partitions

Partitions exist to cap throughput and isolate failures. Record count (even 100B+) is irrelevant compared to read/write rate.

### Observation 2: SQLite is not the primary bottleneck

With WAL, batching, and short transactions, SQLite sustains thousands of ops/sec. The real bottleneck is serialized execution in Durable Objects.

### Observation 3: Single-threaded authority is unavoidable for strong consistency

Any strongly consistent system needs a single ordering point per shard. The question is how much traffic we force through that point.

### Observation 4: Reads and writes have fundamentally different scaling needs

Writes require ordering and durability. Reads require locality, cache, and fan-out. Treating them the same is a design error.

---

## 4. Initial Baseline Design (Rejected)

### One Durable Object per partition

* One DO
* One SQLite database
* All reads and writes serialized

**Pros**:

* Simple
* Correct

**Cons**:

* Hot partition death
* No parallelism
* No future escape hatch

This design was correct but capped ambition too early.

---

## 5. Introducing Sub-Partitions

### PartitionDO + SubDOs

* PartitionDO acts as an orchestrator
* Data stored in multiple SubDOs
* Sort-key based routing using consistent hash ranges

**Benefits**:

* Parallel writes
* Failure isolation
* Future split potential

**Remaining issue**:

* PartitionDO still serialized all traffic

This showed that splitting data alone is insufficient if control remains centralized.

---

## 6. Static Sub-Partitioning (Chosen MVP)

### Design

* One PartitionDO
* ~100 SubDOs per partition
* Static hash ranges
* No dynamic rebalancing initially

**Why this works**:

* Linear throughput increase
* Simple routing
* Low operational risk

**Explicit limits**:

* Hot keys can still overload a SubDO
* Manual rebalancing only

This is a pragmatic MVP that avoids premature distributed complexity.

---

## 7. Read Optimization Layer

### Additions

* Bloom filters per SubDO
* In-memory LRU/LFU cache per SubDO

**Effect**:

* Cache hits avoid disk entirely
* Negative lookups avoid disk via Bloom filters
* Reads become orders of magnitude faster

This makes the system read-dominant friendly but does not change write limits.

---

## 8. Fundamental Bottleneck Identified

Even with SubDOs and caching, the PartitionDO remains:

* single-threaded
* serialized
* a ceiling for read and write throughput

This is the same constraint DynamoDB solves via internal fan-out and replicas.

---

## 9. Read–Write Separation (Final Architecture)

### 9.1 Write Path

* Exactly one authoritative leader DO per partition
* All writes go through the leader
* Leader maintains:

  * SQLite WAL
  * ordered replication log

**Guarantees**:

* Strong consistency
* Total ordering

**Trade-off**:

* Write throughput capped per partition

### 9.2 Read Path

* Many read-replica PartitionDOs
* Globally distributed
* Each replica has:

  * routing metadata
  * Bloom filters
  * in-memory cache

Reads:

* Served locally on cache hit
* Delegated to SubDOs on miss
* Eventual consistency

### 9.3 Consistency Model

Reads must declare intent:

* STRONG_READ → leader
* EVENTUAL_READ → replica

No silent fallback. No ambiguity.

---

## 10. Replication Model

### Leader

* Appends every write to a replication log
* Exposes snapshots and log cursors

### Read Replicas

* Pull snapshots
* Replay log asynchronously
* Track replication lag

Replication lag is observable and first-class.

---

## 11. SubDO Replication (Deferred)

Initially:

* SubDOs are authoritative
* No replicas

Future trigger to replicate SubDOs:

* Cache miss latency dominates p99
* Disk reads become hot

SubDO replication mirrors partition-level leader–follower design.

---

## 12. Throughput-Based Sizing Logic

Partitions are determined by peak writes:

```
partitions = peak_writes_per_sec / writes_per_partition
```

Example:

* 500k writes/sec
* 1k writes/sec per leader

→ 500 partitions

SubDO count is chosen for parallelism and isolation, not capacity.

---

## 13. Comparison to DynamoDB

| Dimension        | This System  | DynamoDB  |
| ---------------- | ------------ | --------- |
| Partition model  | Explicit     | Hidden    |
| Read replicas    | Visible      | Internal  |
| Strong reads     | Explicit     | Explicit  |
| Eventual reads   | Explicit     | Default   |
| Auto rebalancing | Manual       | Automatic |
| Durability       | Configurable | Multi-AZ  |

DynamoDB optimizes for forgiveness and automation. This system optimizes for clarity and control.

---

## 14. Known Trade-offs

### What We Gain

* Predictable performance
* Explicit consistency
* Excellent read scalability
* Cost control

### What We Accept

* Write ceilings per partition
* Eventual consistency for fast reads
* Operational responsibility
* Higher cognitive load

---

## 15. Why This Design Is Honest

At every step, we chose:

* explicit contracts over hidden behavior
* measurable lag over magical consistency
* simple leaders over distributed writes

This makes the system harder to operate but easier to reason about.

---

## 16. Future Work

* Dynamic partition splitting
* Automatic SubDO rebalancing
* Async replication durability tiers
* SubDO read replicas

These are optimizations, not prerequisites.

---

## 17. Final Principle

> Strong consistency, high throughput, and low latency cannot all be maximized simultaneously. This design makes the trade-offs explicit and intentional.
