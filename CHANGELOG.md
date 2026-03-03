# Changelog

All notable changes to **shvm-db** will be documented in this file.

## [v0.3.0] - Architecture v3: Unlimited Partitions & Deterministic Routing

### Overview
Version 3 marks a significant architectural overhaul, moving away from manually managed Replicas and Standby nodes over queues, in favor of a pure deterministic hash-based routing approach straight to a per-partition SQLite Durable Object.

### Added
- **Deterministic Hash Routing:** The API Gateway worker now hashes incoming `TableName` + `PartitionKey` using SHA-256 to derive a deterministic `PartitionDO` ID.
- **Direct DB Evaluation:** Condition expressions and update expressions are now evaluated directly inside the `PartitionDO` against its local SQLite instance, bypassing complex multi-hop state machines.

### Changed
- **Hot-Path Latency:** Control-plane lookups (fetching metadata from `TableRegistryDO` on every request) have been moved out of the hot path. Table schemas are conditionally cached in the worker isolate.
- **SQLite Schema:** Simplified the per-partition SQLite schema down to a pure single-table `items_v3` table optimized for fast key-value lookups.

### Removed
- **SubDO & Replication:** Completely removed `LeaderSubDO`, `ReplicaSubDO`, `StandbySubDO`, the Cloudflare Queue replication pipeline, and the `RoutingTable`. 
- **Control Plane Bottlenecks:** The API gateway no longer asks the registry "where does this partition live?". It calculates the location deterministically.

### Why this improved the system
The previous V2 architecture attempted to manually reinvent Raft-like replication over Cloudflare Queues to scale read throughput. However, the overhead of enqueuing, backfilling, and multiple DO hops (`Worker` -> `Metadata/Router` -> `LeaderDO` -> `Queue` -> `ReplicaDO`) introduced massive tail latencies, race conditions, and test flakiness.

By embracing the Durable Object limits and realizing that a single DO is sufficient *until a partition itself becomes hot* (which is an intentional DynamoDB constraint), we reduced complexity, drastically improved P99 latencies, and made the codebase 100% easier to reason about while maintaining strict AWS SDK API compatibility. Read scaling will be re-introduced in the future at the edge caching layer, rather than via manual DO replication.
