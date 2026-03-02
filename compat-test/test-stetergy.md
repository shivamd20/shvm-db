# DynamoDB API Surface Testing Strategy (Breadth-First, Edge-Case Focused)

## 1. Objectives

This document defines a comprehensive breadth-first testing strategy for validating a DynamoDB-compatible API surface. The focus is not on internal storage mechanics but on correctness, contract fidelity, error semantics, edge cases, and interoperability with official AWS SDKs.

Goals:

* 100% API surface coverage for core operations
* Error-code and validation parity with AWS DynamoDB
* Idempotency correctness
* Consistency model validation
* Pagination and token correctness
* Conditional and transactional correctness
* Concurrency and race condition coverage
* Compatibility with AWS SDK v3 (JavaScript)

---

# 2. Global Testing Dimensions (Applied to ALL APIs)

Every API must be validated across these orthogonal dimensions:

## 2.1 Input Validation

* Missing required fields
* Unknown fields
* Null vs undefined handling
* Empty strings
* Empty maps
* Empty lists
* Max length violations
* Invalid UTF-8
* Binary payload limits
* Attribute name starting with reserved prefix
* Attribute name length limits

## 2.2 Type System Edge Cases

* String vs Number mismatch
* Number precision overflow
* Large numbers beyond 38 digits
* Binary base64 invalid
* Nested map depth limit
* Nested list depth limit
* Empty string disallowed in key attributes
* Empty set disallowed
* Duplicate elements in set
* Mixed types inside set

## 2.3 Size Limits

* Item size > 400KB
* Batch size > 25
* Transaction size > 25
* Response size > 1MB
* Attribute name length max
* Expression length limit

## 2.4 Error Semantics

Validate exact error type:

* ValidationException
* ConditionalCheckFailedException
* ResourceNotFoundException
* ResourceInUseException
* ProvisionedThroughputExceededException
* TransactionCanceledException
* ThrottlingException

Ensure message format compatibility.

## 2.5 Concurrency

* Simultaneous writes same key
* Read after write
* Conditional race
* Transaction conflict

## 2.6 Idempotency

* Retry same request with same client token
* Duplicate CreateTable
* Duplicate PutItem

---

# 3. API Surface Coverage

---

# TABLE MANAGEMENT

## 3.1 CreateTable

### Happy Path

* Minimal table (PK only)
* PK + SK
* With GSI
* With multiple GSIs
* With LSIs
* PAY_PER_REQUEST
* PROVISIONED

### Edge Cases

* Duplicate table name
* Duplicate attribute definitions
* Missing key schema
* GSI key not in attribute definitions
* LSI without sort key
* GSI name duplicate
* Too many GSIs
* Invalid billing mode
* Invalid stream specification
* Tags limit exceeded

### State Validation

* TableStatus transitions
* DescribeTable immediately after create
* Polling until ACTIVE

---

## 3.2 DescribeTable

* Non-existent table
* Immediately after delete
* During CREATING state

---

## 3.3 UpdateTable

### Billing

* Switch billing mode
* Change provisioned throughput

### Index

* Add GSI
* Delete GSI
* Update GSI throughput

### Edge Cases

* Modify primary key (should fail)
* Add duplicate GSI name
* Delete non-existing GSI
* Update while another update in progress

---

## 3.4 DeleteTable

* Delete existing
* Delete non-existing
* Delete while creating
* Recreate immediately after delete

---

# ITEM OPERATIONS

## 4.1 PutItem

### Basic

* Insert new item
* Overwrite existing

### Edge Cases

* Missing key
* Extra key attributes
* Item > 400KB
* Empty string attribute
* Null attribute
* Nested maps
* Deep nesting limit

### ConditionExpression

* attribute_exists
* attribute_not_exists
* Complex AND/OR
* Nested parenthesis
* Invalid expression

### ReturnValues

* NONE
* ALL_OLD

---

## 4.2 GetItem

* Existing item
* Non-existing
* Strongly consistent
* Eventually consistent
* ProjectionExpression
* Invalid projection
* Large item retrieval

---

## 4.3 UpdateItem

### Update Expressions

* SET
* REMOVE
* ADD
* DELETE
* Nested path update
* List index update

### Edge Cases

* Update non-existing item
* Update key attribute
* Invalid expression syntax
* Conditional failure
* Numeric overflow in ADD

---

## 4.4 DeleteItem

* Existing
* Non-existing
* Conditional delete
* ReturnValues

---

# QUERY & SCAN

## 5.1 Query

### Key Conditions

* PK only
* PK + SK equality
* SK range
* BETWEEN
* begins_with

### Edge Cases

* Missing key condition
* Invalid operator
* Using non-key attribute

### Pagination

* Limit
* ExclusiveStartKey
* LastEvaluatedKey correctness
* 1MB response truncation

### FilterExpression

* Filter removing all results
* Complex filter logic

---

## 5.2 Scan

* Full table
* With filter
* With projection
* Pagination
* Segment + TotalSegments (parallel scan)

---

# BATCH OPERATIONS

## 6.1 BatchWriteItem

* 25 items
* More than 25
* Duplicate keys in batch
* UnprocessedItems behavior
* Retry unprocessed

## 6.2 BatchGetItem

* Multiple tables
* Missing keys
* Exceed size limit
* UnprocessedKeys

---

# TRANSACTIONS

## 7.1 TransactWriteItems

* Put
* Update
* Delete
* ConditionCheck
* All in one transaction

### Edge Cases

* Two writes to same item
* Conditional failure
* Capacity exceeded
* > 25 items
* Idempotency token reuse

## 7.2 TransactGetItems

* Multiple items
* Missing item
* Transactional isolation

---

# TTL

## 8.1 UpdateTimeToLive

* Enable TTL
* Disable TTL
* Invalid attribute name

## 8.2 Expiry Behavior

* Expired item not returned in Query
* Expired item visible before purge

---

# STREAMS (if supported)

## 9.1 Stream Specification

* NEW_IMAGE
* OLD_IMAGE
* NEW_AND_OLD_IMAGES
* KEYS_ONLY

## 9.2 Record Ordering

* Multiple updates same key
* Delete then insert

---

# CAPACITY & THROTTLING

## 10.1 Provisioned Mode

* Exceed write capacity
* Exceed read capacity

## 10.2 Adaptive behavior

* Hot partition
* Burst credits

---

# PAGINATION & TOKEN VALIDATION

* Tampered LastEvaluatedKey
* Reusing token after mutation
* Using token from different query

---

# COMPATIBILITY TESTING

## SDK Matrix

* AWS SDK v3 JS
* CLI

## Modes

* Against real AWS DynamoDB
* Against local DynamoDB
* Against your implementation

All tests must run against all backends and diff responses.

---

# TEST EXECUTION STRATEGY

1. Each API = dedicated test suite
2. Every suite contains:

   * Happy path
   * Validation
   * Size limits
   * Concurrency
   * Error semantics
3. Snapshot response comparison
4. Error code + message match
5. Automated fuzzing for:

   * Attribute names
   * Expression grammar
   * Deep nested structures

---

# SUCCESS CRITERIA

* Zero diff vs AWS responses
* Error parity
* Token compatibility
* SDK compatibility
* Deterministic behavior under concurrency

---

This strategy guarantees broad API correctness and high confidence DynamoDB compatibility without diving into storage-layer implementation details.
