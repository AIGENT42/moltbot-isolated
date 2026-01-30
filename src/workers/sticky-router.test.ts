import { describe, it, expect, beforeEach } from 'vitest';
import { StickyRouter, createStickyRouter } from './sticky-router.js';

describe('StickyRouter', () => {
  let router: StickyRouter;

  beforeEach(() => {
    router = new StickyRouter();
  });

  describe('worker management', () => {
    it('should add workers to the router', () => {
      router.addWorker('worker-0');
      router.addWorker('worker-1');

      expect(router.workerCount).toBe(2);
      expect(router.getWorkers()).toEqual(['worker-0', 'worker-1']);
    });

    it('should not add duplicate workers', () => {
      router.addWorker('worker-0');
      router.addWorker('worker-0');

      expect(router.workerCount).toBe(1);
    });

    it('should remove workers from the router', () => {
      router.addWorker('worker-0');
      router.addWorker('worker-1');
      router.removeWorker('worker-0');

      expect(router.workerCount).toBe(1);
      expect(router.getWorkers()).toEqual(['worker-1']);
    });

    it('should handle removing non-existent workers', () => {
      router.addWorker('worker-0');
      router.removeWorker('worker-1');

      expect(router.workerCount).toBe(1);
    });
  });

  describe('routing', () => {
    beforeEach(() => {
      router.addWorker('worker-0');
      router.addWorker('worker-1');
      router.addWorker('worker-2');
      router.addWorker('worker-3');
    });

    it('should route users to workers', () => {
      const decision = router.route('user-123');

      expect(decision.userId).toBe('user-123');
      expect(decision.workerId).toMatch(/^worker-[0-3]$/);
      expect(typeof decision.hashValue).toBe('number');
    });

    it('should provide sticky routing (same user → same worker)', () => {
      const decision1 = router.route('user-123');
      const decision2 = router.route('user-123');
      const decision3 = router.route('user-123');

      expect(decision1.workerId).toBe(decision2.workerId);
      expect(decision2.workerId).toBe(decision3.workerId);
    });

    it('should mark first assignment as new', () => {
      const decision1 = router.route('user-123');
      const decision2 = router.route('user-123');

      expect(decision1.isNewAssignment).toBe(true);
      expect(decision2.isNewAssignment).toBe(false);
    });

    it('should distribute users across workers', () => {
      // Route many users and check distribution
      const users = Array.from({ length: 1000 }, (_, i) => `user-${i}`);
      const assignments = new Map<string, number>();

      for (const user of users) {
        const decision = router.route(user);
        const count = assignments.get(decision.workerId) ?? 0;
        assignments.set(decision.workerId, count + 1);
      }

      // Each worker should get at least some users (rough distribution check)
      for (const workerId of router.getWorkers()) {
        const count = assignments.get(workerId) ?? 0;
        // With 4 workers and 1000 users, each should get 100-400 (allowing variance)
        expect(count).toBeGreaterThan(50);
        expect(count).toBeLessThan(500);
      }
    });

    it('should throw when no workers available', () => {
      const emptyRouter = new StickyRouter();
      expect(() => emptyRouter.route('user-123')).toThrow(
        'No workers available'
      );
    });
  });

  describe('peek', () => {
    beforeEach(() => {
      router.addWorker('worker-0');
      router.addWorker('worker-1');
    });

    it('should peek without caching', () => {
      const workerId = router.peek('user-123');

      expect(workerId).toMatch(/^worker-[01]$/);
      expect(router.routingTableSize).toBe(0);
    });

    it('should return null when no workers', () => {
      const emptyRouter = new StickyRouter();
      expect(emptyRouter.peek('user-123')).toBeNull();
    });
  });

  describe('force assignment', () => {
    beforeEach(() => {
      router.addWorker('worker-0');
      router.addWorker('worker-1');
    });

    it('should force assign a user to a specific worker', () => {
      router.forceAssign('user-123', 'worker-1');
      const decision = router.route('user-123');

      expect(decision.workerId).toBe('worker-1');
    });

    it('should throw when forcing to non-existent worker', () => {
      expect(() => router.forceAssign('user-123', 'worker-99')).toThrow(
        'Worker worker-99 not in routing pool'
      );
    });
  });

  describe('clear assignment', () => {
    beforeEach(() => {
      router.addWorker('worker-0');
      router.addWorker('worker-1');
    });

    it('should clear a user assignment', () => {
      router.route('user-123');
      expect(router.routingTableSize).toBe(1);

      router.clearAssignment('user-123');
      expect(router.routingTableSize).toBe(0);
    });

    it('should allow re-routing after clearing', () => {
      const decision1 = router.route('user-123');
      router.clearAssignment('user-123');
      const decision2 = router.route('user-123');

      expect(decision2.isNewAssignment).toBe(true);
      // Note: may or may not be the same worker depending on hash
    });
  });

  describe('worker removal with active assignments', () => {
    beforeEach(() => {
      router.addWorker('worker-0');
      router.addWorker('worker-1');
    });

    it('should reroute users when their worker is removed', () => {
      // Route some users
      router.route('user-1');
      router.route('user-2');
      router.route('user-3');

      const assignments = router.getAssignments();
      const usersOnWorker0 = [...assignments.entries()].filter(
        ([_, w]) => w === 'worker-0'
      );

      // Remove worker-0
      router.removeWorker('worker-0');

      // Users that were on worker-0 should be cleared from cache
      for (const [userId] of usersOnWorker0) {
        // Re-routing should now go to worker-1
        const decision = router.route(userId);
        expect(decision.workerId).toBe('worker-1');
      }
    });
  });

  describe('getDistribution', () => {
    beforeEach(() => {
      router.addWorker('worker-0');
      router.addWorker('worker-1');
    });

    it('should return distribution of cached assignments', () => {
      router.route('user-1');
      router.route('user-2');
      router.route('user-3');

      const distribution = router.getDistribution();

      expect(distribution.size).toBe(2);
      const total = [...distribution.values()].reduce((a, b) => a + b, 0);
      expect(total).toBe(3);
    });
  });

  describe('state export/import', () => {
    it('should export and import router state', () => {
      router.addWorker('worker-0');
      router.addWorker('worker-1');
      router.route('user-1');
      router.route('user-2');
      router.forceAssign('user-3', 'worker-0');

      const state = router.exportState();

      // Create new router from state
      const newRouter = StickyRouter.fromState(state);

      expect(newRouter.workerCount).toBe(2);
      expect(newRouter.routingTableSize).toBe(3);

      // Check routing is preserved
      const decision = newRouter.route('user-1');
      expect(decision.isNewAssignment).toBe(false);
    });

    it('should skip assignments for removed workers during import', () => {
      router.addWorker('worker-0');
      router.addWorker('worker-1');
      router.route('user-1');
      router.forceAssign('user-2', 'worker-1');

      const state = router.exportState();

      // Modify state to remove worker-1
      state.workers = ['worker-0'];

      const newRouter = StickyRouter.fromState(state);

      // user-2's assignment should not be imported
      expect(newRouter.routingTableSize).toBeLessThanOrEqual(1);
    });
  });

  describe('createStickyRouter helper', () => {
    it('should create router with workers', () => {
      const router = createStickyRouter(['w-0', 'w-1', 'w-2']);

      expect(router.workerCount).toBe(3);
      expect(router.getWorkers()).toEqual(['w-0', 'w-1', 'w-2']);
    });

    it('should accept custom virtual nodes', () => {
      const router = createStickyRouter(['w-0', 'w-1'], 50);

      expect(router.workerCount).toBe(2);
    });
  });

  describe('consistent hashing properties', () => {
    it('should maintain routing when adding a worker', () => {
      router.addWorker('worker-0');
      router.addWorker('worker-1');

      // Route some users
      const originalAssignments = new Map<string, string>();
      for (let i = 0; i < 100; i++) {
        const userId = `user-${i}`;
        const decision = router.route(userId);
        originalAssignments.set(userId, decision.workerId);
      }

      // Add a new worker
      router.addWorker('worker-2');

      // Most existing assignments should be preserved (from cache)
      let preserved = 0;
      for (const [userId, originalWorker] of originalAssignments) {
        const decision = router.route(userId);
        if (decision.workerId === originalWorker) {
          preserved++;
        }
      }

      // All cached assignments should be preserved
      expect(preserved).toBe(100);
    });
  });
});
