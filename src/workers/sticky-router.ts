/**
 * Sticky Router - Consistent hash-based routing from userId to workerId
 *
 * Uses consistent hashing to ensure:
 * 1. Same userId always routes to same worker
 * 2. Minimal disruption when workers are added/removed
 * 3. Even distribution across workers
 */

import type { RoutingDecision, UserId, WorkerId } from './types.js';

/** Number of virtual nodes per worker for better distribution */
const DEFAULT_VIRTUAL_NODES = 150;

/** Consistent hash ring node */
interface HashRingNode {
  hash: number;
  workerId: WorkerId;
  virtualIndex: number;
}

/**
 * FNV-1a hash function - fast and good distribution
 * Returns a 32-bit unsigned integer
 */
function fnv1aHash(str: string): number {
  let hash = 2166136261; // FNV offset basis
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    // FNV prime: multiply by 16777619
    hash = Math.imul(hash, 16777619);
  }
  // Convert to unsigned 32-bit integer
  return hash >>> 0;
}

/**
 * Binary search to find the first node with hash >= target
 */
function findNode(ring: HashRingNode[], targetHash: number): HashRingNode {
  if (ring.length === 0) {
    throw new Error('Hash ring is empty');
  }

  let left = 0;
  let right = ring.length - 1;

  // If target is greater than all hashes, wrap to first node
  if (targetHash > ring[right].hash) {
    return ring[0];
  }

  while (left < right) {
    const mid = (left + right) >>> 1;
    if (ring[mid].hash < targetHash) {
      left = mid + 1;
    } else {
      right = mid;
    }
  }

  return ring[left];
}

/**
 * Sticky Router using consistent hashing
 */
export class StickyRouter {
  /** Sorted hash ring */
  private ring: HashRingNode[] = [];

  /** Set of active worker IDs */
  private workers: Set<WorkerId> = new Set();

  /** Cache of userId -> workerId assignments */
  private routingCache: Map<UserId, WorkerId> = new Map();

  /** Number of virtual nodes per worker */
  private virtualNodes: number;

  constructor(virtualNodes: number = DEFAULT_VIRTUAL_NODES) {
    this.virtualNodes = virtualNodes;
  }

  /**
   * Add a worker to the hash ring
   */
  addWorker(workerId: WorkerId): void {
    if (this.workers.has(workerId)) {
      return; // Already added
    }

    this.workers.add(workerId);

    // Add virtual nodes for this worker
    for (let i = 0; i < this.virtualNodes; i++) {
      const virtualKey = `${workerId}:${i}`;
      const hash = fnv1aHash(virtualKey);
      this.ring.push({ hash, workerId, virtualIndex: i });
    }

    // Sort ring by hash value
    this.ring.sort((a, b) => a.hash - b.hash);

    // Invalidate cache entries that might need to be rerouted
    this.invalidateAffectedRoutes(workerId);
  }

  /**
   * Remove a worker from the hash ring
   */
  removeWorker(workerId: WorkerId): void {
    if (!this.workers.has(workerId)) {
      return; // Not in ring
    }

    this.workers.delete(workerId);

    // Remove all virtual nodes for this worker
    this.ring = this.ring.filter((node) => node.workerId !== workerId);

    // Invalidate cache entries for this worker
    for (const [userId, cachedWorkerId] of this.routingCache) {
      if (cachedWorkerId === workerId) {
        this.routingCache.delete(userId);
      }
    }
  }

  /**
   * Route a userId to a workerId
   */
  route(userId: UserId): RoutingDecision {
    if (this.ring.length === 0) {
      throw new Error('No workers available for routing');
    }

    // Check cache first
    const cachedWorkerId = this.routingCache.get(userId);
    if (cachedWorkerId && this.workers.has(cachedWorkerId)) {
      const hashValue = fnv1aHash(userId);
      return {
        workerId: cachedWorkerId,
        userId,
        hashValue,
        isNewAssignment: false,
      };
    }

    // Calculate hash and find worker
    const hashValue = fnv1aHash(userId);
    const node = findNode(this.ring, hashValue);

    // Cache the assignment
    this.routingCache.set(userId, node.workerId);

    return {
      workerId: node.workerId,
      userId,
      hashValue,
      isNewAssignment: !cachedWorkerId,
    };
  }

  /**
   * Get the worker for a userId without caching
   */
  peek(userId: UserId): WorkerId | null {
    if (this.ring.length === 0) {
      return null;
    }

    const hashValue = fnv1aHash(userId);
    const node = findNode(this.ring, hashValue);
    return node.workerId;
  }

  /**
   * Force assign a userId to a specific worker
   * Useful for manual overrides or migrations
   */
  forceAssign(userId: UserId, workerId: WorkerId): void {
    if (!this.workers.has(workerId)) {
      throw new Error(`Worker ${workerId} not in routing pool`);
    }
    this.routingCache.set(userId, workerId);
  }

  /**
   * Clear assignment for a userId (next request will be routed fresh)
   */
  clearAssignment(userId: UserId): void {
    this.routingCache.delete(userId);
  }

  /**
   * Get all cached assignments
   */
  getAssignments(): Map<UserId, WorkerId> {
    return new Map(this.routingCache);
  }

  /**
   * Get distribution statistics
   */
  getDistribution(): Map<WorkerId, number> {
    const distribution = new Map<WorkerId, number>();
    for (const workerId of this.workers) {
      distribution.set(workerId, 0);
    }
    for (const workerId of this.routingCache.values()) {
      const count = distribution.get(workerId) ?? 0;
      distribution.set(workerId, count + 1);
    }
    return distribution;
  }

  /**
   * Get list of active workers
   */
  getWorkers(): WorkerId[] {
    return Array.from(this.workers);
  }

  /**
   * Get number of active workers
   */
  get workerCount(): number {
    return this.workers.size;
  }

  /**
   * Get number of cached assignments
   */
  get routingTableSize(): number {
    return this.routingCache.size;
  }

  /**
   * Clear all cached assignments
   */
  clearCache(): void {
    this.routingCache.clear();
  }

  /**
   * Invalidate routes that might be affected by a new worker
   * This is called when a new worker is added
   */
  private invalidateAffectedRoutes(newWorkerId: WorkerId): void {
    // For simplicity, we don't invalidate existing routes when a worker is added
    // This ensures sticky routing - existing users keep their current worker
    // Only new users or users whose worker was removed will be rerouted
    //
    // If you need to rebalance, call clearCache() explicitly
  }

  /**
   * Export router state for persistence
   */
  exportState(): StickyRouterState {
    return {
      workers: Array.from(this.workers),
      assignments: Array.from(this.routingCache.entries()),
      virtualNodes: this.virtualNodes,
    };
  }

  /**
   * Import router state from persistence
   */
  static fromState(state: StickyRouterState): StickyRouter {
    const router = new StickyRouter(state.virtualNodes);
    for (const workerId of state.workers) {
      router.addWorker(workerId);
    }
    for (const [userId, workerId] of state.assignments) {
      if (router.workers.has(workerId)) {
        router.routingCache.set(userId, workerId);
      }
    }
    return router;
  }
}

/** Serializable router state */
export interface StickyRouterState {
  workers: WorkerId[];
  assignments: [UserId, WorkerId][];
  virtualNodes: number;
}

/**
 * Create a default sticky router with specified workers
 */
export function createStickyRouter(
  workerIds: WorkerId[],
  virtualNodes?: number
): StickyRouter {
  const router = new StickyRouter(virtualNodes);
  for (const workerId of workerIds) {
    router.addWorker(workerId);
  }
  return router;
}
