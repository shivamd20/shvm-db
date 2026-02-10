export const PARTITION_KEY_MAX_SIZE = 2048; // bytes
export const SORT_KEY_MAX_SIZE = 1024; // bytes
export const ITEM_MAX_SIZE = 400 * 1024; // 400KB
export const BLOOM_FILTER_SIZE = 128 * 1024 * 8; // 128KB in bits (approx 1Mb)
export const LRU_CACHE_CAPACITY = 100; // Small capacity (items)
export const LRU_MAX_KEY_SIZE = 128; // bytes - only cache small keys
