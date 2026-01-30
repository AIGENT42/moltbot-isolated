import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rm, stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkerSandbox, SandboxManager } from './worker-sandbox.js';

describe('WorkerSandbox', () => {
  const testBaseDir = join(tmpdir(), 'moltbot-sandbox-test');
  let sandbox: WorkerSandbox;

  beforeEach(async () => {
    sandbox = new WorkerSandbox('test-worker', testBaseDir);
  });

  afterEach(async () => {
    try {
      await rm(testBaseDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('initialization', () => {
    it('should create sandbox directories', async () => {
      await sandbox.initialize();

      // Check all directories exist
      const dirs = [
        sandbox.paths.root,
        sandbox.paths.sessions,
        sandbox.paths.temp,
        sandbox.paths.cache,
        sandbox.paths.state,
        sandbox.paths.logs,
      ];

      for (const dir of dirs) {
        const stats = await stat(dir);
        expect(stats.isDirectory()).toBe(true);
      }
    });

    it('should create metadata file', async () => {
      await sandbox.initialize();

      const metadata = await sandbox.getMetadata();
      expect(metadata).not.toBeNull();
      expect(metadata?.workerId).toBe('test-worker');
      expect(metadata?.version).toBe(1);
    });

    it('should be idempotent', async () => {
      await sandbox.initialize();
      const firstMetadata = await sandbox.getMetadata();

      await sandbox.initialize();
      const secondMetadata = await sandbox.getMetadata();

      expect(secondMetadata?.createdAt).toBe(firstMetadata?.createdAt);
    });
  });

  describe('path helpers', () => {
    it('should generate safe session paths', () => {
      const path = sandbox.getSessionPath('session-123');
      expect(path).toBe(join(testBaseDir, 'test-worker', 'sessions', 'session-123.json'));
    });

    it('should sanitize dangerous characters in paths', () => {
      const path = sandbox.getSessionPath('../../../etc/passwd');
      expect(path).not.toContain('..');
      expect(path).toBe(
        join(testBaseDir, 'test-worker', 'sessions', '______etc_passwd.json')
      );
    });

    it('should generate temp paths', () => {
      const path = sandbox.getTempPath('upload.tmp');
      expect(path).toBe(join(testBaseDir, 'test-worker', 'temp', 'upload.tmp'));
    });

    it('should generate cache paths', () => {
      const path = sandbox.getCachePath('model-cache');
      expect(path).toBe(join(testBaseDir, 'test-worker', 'cache', 'model-cache'));
    });

    it('should generate state paths', () => {
      const path = sandbox.getStatePath('conversation');
      expect(path).toBe(
        join(testBaseDir, 'test-worker', 'state', 'conversation.json')
      );
    });

    it('should generate log paths', () => {
      const path = sandbox.getLogPath('worker');
      expect(path).toBe(join(testBaseDir, 'test-worker', 'logs', 'worker.log'));
    });
  });

  describe('state operations', () => {
    beforeEach(async () => {
      await sandbox.initialize();
    });

    it('should write and read state', async () => {
      const data = { count: 42, messages: ['hello', 'world'] };
      await sandbox.writeState('test-state', data);

      const retrieved = await sandbox.readState<typeof data>('test-state');
      expect(retrieved).toEqual(data);
    });

    it('should return null for non-existent state', async () => {
      const state = await sandbox.readState('non-existent');
      expect(state).toBeNull();
    });
  });

  describe('exists', () => {
    it('should return false before initialization', async () => {
      expect(await sandbox.exists()).toBe(false);
    });

    it('should return true after initialization', async () => {
      await sandbox.initialize();
      expect(await sandbox.exists()).toBe(true);
    });
  });

  describe('clearTemp', () => {
    beforeEach(async () => {
      await sandbox.initialize();
    });

    it('should clear temp directory', async () => {
      // Write a temp file
      const tempPath = sandbox.getTempPath('test.tmp');
      await import('node:fs/promises').then((fs) =>
        fs.writeFile(tempPath, 'test data')
      );

      // Clear temp
      await sandbox.clearTemp();

      // Check file is gone but directory exists
      const stats = await stat(sandbox.paths.temp);
      expect(stats.isDirectory()).toBe(true);

      try {
        await stat(tempPath);
        expect.fail('File should not exist');
      } catch {
        // Expected
      }
    });
  });

  describe('clearCache', () => {
    beforeEach(async () => {
      await sandbox.initialize();
    });

    it('should clear cache directory', async () => {
      // Write a cache file
      const cachePath = sandbox.getCachePath('test.cache');
      await import('node:fs/promises').then((fs) =>
        fs.writeFile(cachePath, 'cached data')
      );

      // Clear cache
      await sandbox.clearCache();

      // Check directory exists but file is gone
      const stats = await stat(sandbox.paths.cache);
      expect(stats.isDirectory()).toBe(true);

      try {
        await stat(cachePath);
        expect.fail('File should not exist');
      } catch {
        // Expected
      }
    });
  });

  describe('destroy', () => {
    it('should remove the entire sandbox', async () => {
      await sandbox.initialize();
      expect(await sandbox.exists()).toBe(true);

      await sandbox.destroy();
      expect(await sandbox.exists()).toBe(false);
    });
  });

  describe('touch', () => {
    beforeEach(async () => {
      await sandbox.initialize();
    });

    it('should update lastAccessed timestamp', async () => {
      const beforeMetadata = await sandbox.getMetadata();
      const beforeAccess = beforeMetadata?.lastAccessed ?? 0;

      // Wait a bit and touch
      await new Promise((r) => setTimeout(r, 10));
      await sandbox.touch();

      const afterMetadata = await sandbox.getMetadata();
      expect(afterMetadata?.lastAccessed).toBeGreaterThan(beforeAccess);
    });
  });

  describe('getEnvironment', () => {
    it('should return environment variables', () => {
      const env = sandbox.getEnvironment();

      expect(env.MOLTBOT_WORKER_ID).toBe('test-worker');
      expect(env.MOLTBOT_SANDBOX_ROOT).toBe(sandbox.paths.root);
      expect(env.MOLTBOT_SESSIONS_DIR).toBe(sandbox.paths.sessions);
      expect(env.MOLTBOT_TEMP_DIR).toBe(sandbox.paths.temp);
      expect(env.MOLTBOT_CACHE_DIR).toBe(sandbox.paths.cache);
      expect(env.TMPDIR).toBe(sandbox.paths.temp);
    });
  });
});

describe('SandboxManager', () => {
  const testBaseDir = join(tmpdir(), 'moltbot-manager-test');
  let manager: SandboxManager;

  beforeEach(async () => {
    manager = new SandboxManager(testBaseDir);
    await manager.initialize();
  });

  afterEach(async () => {
    try {
      await rm(testBaseDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('getSandbox', () => {
    it('should create and return a sandbox', async () => {
      const sandbox = await manager.getSandbox('worker-1');

      expect(sandbox.workerId).toBe('worker-1');
      expect(await sandbox.exists()).toBe(true);
    });

    it('should return the same sandbox on repeated calls', async () => {
      const sandbox1 = await manager.getSandbox('worker-1');
      const sandbox2 = await manager.getSandbox('worker-1');

      expect(sandbox1).toBe(sandbox2);
    });

    it('should create different sandboxes for different workers', async () => {
      const sandbox1 = await manager.getSandbox('worker-1');
      const sandbox2 = await manager.getSandbox('worker-2');

      expect(sandbox1.paths.root).not.toBe(sandbox2.paths.root);
    });
  });

  describe('removeSandbox', () => {
    it('should remove sandbox from manager', async () => {
      const sandbox = await manager.getSandbox('worker-1');
      const sandboxes = manager.getSandboxes();
      expect(sandboxes.has('worker-1')).toBe(true);

      await manager.removeSandbox('worker-1');
      expect(manager.getSandboxes().has('worker-1')).toBe(false);

      // Sandbox directory still exists (not destroyed)
      expect(await sandbox.exists()).toBe(true);
    });

    it('should destroy sandbox when requested', async () => {
      const sandbox = await manager.getSandbox('worker-1');
      await manager.removeSandbox('worker-1', true);

      expect(await sandbox.exists()).toBe(false);
    });
  });

  describe('cleanup', () => {
    it('should clean up old sandboxes', async () => {
      // Create a sandbox
      const sandbox = await manager.getSandbox('worker-old');
      const metadata = await sandbox.getMetadata();

      // Manually set lastAccessed to old time
      const oldTime = Date.now() - 1000 * 60 * 60 * 24 * 7; // 7 days ago
      const metadataPath = join(sandbox.paths.root, 'sandbox.json');
      await import('node:fs/promises').then((fs) =>
        fs.writeFile(
          metadataPath,
          JSON.stringify({ ...metadata, lastAccessed: oldTime })
        )
      );

      // Clean up sandboxes older than 1 day
      const cleaned = await manager.cleanup(1000 * 60 * 60 * 24);

      expect(cleaned).toContain('worker-old');
      expect(await sandbox.exists()).toBe(false);
    });

    it('should not clean up recent sandboxes', async () => {
      const sandbox = await manager.getSandbox('worker-new');
      await sandbox.touch();

      // Clean up sandboxes older than 1 day
      const cleaned = await manager.cleanup(1000 * 60 * 60 * 24);

      expect(cleaned).not.toContain('worker-new');
      expect(await sandbox.exists()).toBe(true);
    });
  });
});
