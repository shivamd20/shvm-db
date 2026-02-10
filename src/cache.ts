
import { LRU_MAX_KEY_SIZE } from "./constants";

export class LRUCache<K, V> {

    private capacity: number;
    private cache: Map<K, V>;


    constructor(capacity: number) {
        this.capacity = capacity;
        this.cache = new Map();
    }

    get(key: K): V | undefined {
        if (!this.cache.has(key)) return undefined;
        // Refresh item (delete and re-add)
        const value = this.cache.get(key)!;
        this.cache.delete(key);
        this.cache.set(key, value);
        return value;
    }

    put(key: K, value: V): void {
        // Enforce key size limit for string keys to save memory
        if (typeof key === 'string' && key.length > LRU_MAX_KEY_SIZE) {
            return; // Don't cache large keys
        }


        if (this.cache.has(key)) {
            // Update existing item
            this.cache.delete(key);
            this.cache.set(key, value);
        } else {
            // Add new item
            this.cache.set(key, value);
            // Evict if over capacity
            if (this.cache.size > this.capacity) {
                // Map iterator yields insertion order, so next().value is the oldest
                const oldestKey = this.cache.keys().next().value;
                if (oldestKey !== undefined) {
                    this.cache.delete(oldestKey);
                }
            }
        }
    }

    remove(key: K): void {
        this.cache.delete(key);
    }

    clear(): void {
        this.cache.clear();
    }
}

export class BloomFilter {
    private size: number; // Size in bits
    private bitArray: Uint8Array;
    private seed: number;

    constructor(size: number = 1024 * 1024, seed: number = 0x12345678) { // Default ~1Mb bits = 128KB

        this.size = size;
        this.bitArray = new Uint8Array(Math.ceil(size / 8));
        this.seed = seed;
    }

    // FNV-1a hash function
    private hash(str: string, seed: number): number {
        let h = seed;
        for (let i = 0; i < str.length; i++) {
            h ^= str.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }
        return h >>> 0;
    }

    // Get k hash positions
    private getPositions(str: string): number[] {
        // Use double hashing: h1(x) + i * h2(x)
        const h1 = this.hash(str, this.seed);
        const h2 = this.hash(str, this.seed + 1);
        const k = 3; // Number of hash functions
        const positions: number[] = [];

        for (let i = 0; i < k; i++) {
            const pos = (h1 + i * h2) % this.size;
            positions.push(pos < 0 ? pos + this.size : pos);
        }
        return positions;
    }

    add(str: string): void {
        const positions = this.getPositions(str);
        for (const pos of positions) {
            const index = Math.floor(pos / 8);
            const bit = pos % 8;
            this.bitArray[index] |= (1 << bit);
        }
    }

    has(str: string): boolean {
        const positions = this.getPositions(str);
        for (const pos of positions) {
            const index = Math.floor(pos / 8);
            const bit = pos % 8;
            if ((this.bitArray[index] & (1 << bit)) === 0) {
                return false;
            }
        }
        return true;
    }

    // Serialize to base64 for storage
    serialize(): string {
        // Convert Uint8Array to binary string then btoa
        let binary = '';
        const len = this.bitArray.byteLength;
        for (let i = 0; i < len; i++) {
            binary += String.fromCharCode(this.bitArray[i]);
        }
        return btoa(binary);
    }

    // Deserialize from base64
    static deserialize(base64: string, size: number = 256 * 1024, seed: number = 0x12345678): BloomFilter {
        const bf = new BloomFilter(size, seed);
        try {
            const binary = atob(base64);
            const len = binary.length;
            for (let i = 0; i < len; i++) {
                bf.bitArray[i] = binary.charCodeAt(i);
            }
        } catch (e) {
            console.error("Failed to deserialize bloom filter", e);
        }
        return bf;
    }
}
