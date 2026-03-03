# ROADMAP

This document outlines the planned future work and open problems for **shvm-db** as it evolves beyond the v3 architecture.

## Phase 0.5: WAL Offload (Next Immediate Step)
Currently, all durability relies on the Cloudflare Durable Object's attached SQLite database. We want to externalize this to allow for point-in-time recovery and faster, non-blocking acknowledgments.
*   **External write-ahead log** in object storage (e.g., Cloudflare R2).
*   **Faster acknowledgements** by relying on the external WAL rather than waiting for SQLite syncs under high contention.
*   **Crash replay** independent of SQLite corruption.

## Phase 2: Partition Scaling & Splitting
Currently, each partition maps statically to a single Durable Object based on a hash of the Partition Key. If a single Partition Key receives too much data, the DO's storage limit is reached.
*   **Sort-key range splitting:** Dynamically split a single Partition Key across multiple DOs based on Sort Key ranges when it gets too large.
*   **Dual-writes during migration:** Ensure no downtime while an actively splitting partition moves data to its children.
*   **Router updates:** The worker router needs to dynamically look up these sub-partitions.

## Phase 3: Global Secondary Indexes (GSI)
To support querying on attributes other than the primary key, we need secondary indexes.
*   **GSI via Eventual Consistency:** Project attributes from the main PartitionDO into a completely different Partition Key space (a different DO) reliably over a queue or event stream.

## Phase 4: Transactions
DynamoDB supports `TransactWriteItems`, which provides ACID guarantees across multiple partitions.
*   **Two-phase commit (2PC):** Build a transaction coordinator to execute writes across multiple `PartitionDO` entities simultaneously.

## Open Problems / Contributing

These represent the hardest distributed systems problems currently facing `shvm-db`. PRs are welcome!

1.  **Partition Splitting Implementation**: Right now, partitions are static. Implementing the mechanism to dynamically detect when a single `PartitionDO` exceeds a storage or compute threshold, bisect its Sort Key range, and spawn two new `PartitionDOs` without downtime is the holy grail.
2.  **Global Secondary Indexes (GSI) Projection Engine**: How do we project attributes from a Leader DO into a totally different Partition Key space reliably? We need an eventually consistent projection engine that doesn't bottleneck the main write path.
3.  **Cross-Partition Transactions**: Implementing a reliable Two-Phase Commit (2PC) coordinator across multiple `PartitionDOs` over unreliable networks to support AWS SDK standard transactions.
