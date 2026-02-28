export const PARTITION_KEY_MAX_SIZE = 2048; // bytes
export const SORT_KEY_MAX_SIZE = 1024; // bytes
export const ITEM_MAX_SIZE = 400 * 1024; // 400KB
export const BLOOM_FILTER_SIZE = 256 * 1024 * 8; // 256KB in bits (larger for better hit rate)
export const LRU_CACHE_CAPACITY = 500; // Increased for write-through cache (more reads from memory)
export const LRU_MAX_KEY_SIZE = 128; // bytes - only cache small keys
