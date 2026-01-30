/**
 * Worker Sandbox - Isolated filesystem and state per worker
 *
 * Each worker gets its own:
 * - Session storage directory
 * - Temporary files directory
 * - Cache directory
 * - State files
 *
 * No shared mutable state between workers.
 */

import { mkdir, rm, stat, writeFile, readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { WorkerId, InstanceKeys } from './types.js';

/** Sandbox directory structure */
export interface SandboxPaths {
  /** Root directory for this worker's sandbox */
  root: string;
  /** Session storage directory */
  sessions: string;
  /** Temporary files directory */
  temp: string;
  /** Cache directory */
  cache: string;
  /** State files directory */
  state: string;
  /** Logs directory */
  logs: string;
  /** Credentials directory (OAuth tokens, API keys) */
  credentials: string;
  /** Config directory */
  config: string;
  /** Keys directory (instance private keys) */
  keys: string;
}

/** Sandbox metadata */
export interface SandboxMetadata {
  workerId: WorkerId;
  createdAt: number;
  lastAccessed: number;
  version: number;
  /** Fingerprint of instance private key (first 8 bytes hex) */
  keyFingerprint?: string;
}

const SANDBOX_VERSION = 1;
const METADATA_FILE = 'sandbox.json';

/**
 * Worker Sandbox - manages isolated filesystem for a worker
 */
export class WorkerSandbox {
  readonly workerId: WorkerId;
  readonly paths: SandboxPaths;
  private initialized = false;

  constructor(workerId: WorkerId, baseDir: string) {
    this.workerId = workerId;
    const workerRoot = join(baseDir, workerId);
    this.paths = {
      root: workerRoot,
      sessions: join(workerRoot, 'sessions'),
      temp: join(workerRoot, 'temp'),
      cache: join(workerRoot, 'cache'),
      state: join(workerRoot, 'state'),
      logs: join(workerRoot, 'logs'),
      credentials: join(workerRoot, 'credentials'),
      config: join(workerRoot, 'config'),
      keys: join(workerRoot, 'keys'),
    };
  }

  /**
   * Initialize the sandbox directories and generate instance keys
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // Create all directories
    await Promise.all([
      mkdir(this.paths.sessions, { recursive: true }),
      mkdir(this.paths.temp, { recursive: true }),
      mkdir(this.paths.cache, { recursive: true }),
      mkdir(this.paths.state, { recursive: true }),
      mkdir(this.paths.logs, { recursive: true }),
      mkdir(this.paths.credentials, { recursive: true }),
      mkdir(this.paths.config, { recursive: true }),
      mkdir(this.paths.keys, { recursive: true }),
    ]);

    // Generate instance keys if they don't exist
    const keys = await this.getOrCreateInstanceKeys();

    // Write or update metadata
    const metadata: SandboxMetadata = {
      workerId: this.workerId,
      createdAt: Date.now(),
      lastAccessed: Date.now(),
      version: SANDBOX_VERSION,
      keyFingerprint: keys.fingerprint,
    };

    const existingMetadata = await this.getMetadata();
    if (existingMetadata) {
      metadata.createdAt = existingMetadata.createdAt;
    }

    await this.writeMetadata(metadata);
    this.initialized = true;
  }

  /**
   * Get sandbox metadata
   */
  async getMetadata(): Promise<SandboxMetadata | null> {
    try {
      const metadataPath = join(this.paths.root, METADATA_FILE);
      const content = await readFile(metadataPath, 'utf-8');
      return JSON.parse(content) as SandboxMetadata;
    } catch {
      return null;
    }
  }

  /**
   * Write sandbox metadata
   */
  private async writeMetadata(metadata: SandboxMetadata): Promise<void> {
    const metadataPath = join(this.paths.root, METADATA_FILE);
    await writeFile(metadataPath, JSON.stringify(metadata, null, 2));
  }

  /**
   * Update last accessed timestamp
   */
  async touch(): Promise<void> {
    const metadata = await this.getMetadata();
    if (metadata) {
      metadata.lastAccessed = Date.now();
      await this.writeMetadata(metadata);
    }
  }

  /**
   * Get or create instance private keys for this worker.
   * Keys are persisted to disk and reused across restarts.
   */
  async getOrCreateInstanceKeys(): Promise<InstanceKeys> {
    const keyPath = join(this.paths.keys, 'instance.key');
    const idPath = join(this.paths.keys, 'instance.id');

    try {
      // Try to read existing keys
      const [privateKeyHex, instanceId] = await Promise.all([
        readFile(keyPath, 'utf-8'),
        readFile(idPath, 'utf-8'),
      ]);
      const privateKey = Buffer.from(privateKeyHex.trim(), 'hex');
      const fingerprint = privateKey.subarray(0, 8).toString('hex');
      return {
        privateKey,
        instanceId: instanceId.trim(),
        fingerprint,
      };
    } catch {
      // Generate new keys
      return this.generateInstanceKeys();
    }
  }

  /**
   * Generate new instance private keys.
   * Creates a 32-byte private key and a unique instance ID.
   */
  private async generateInstanceKeys(): Promise<InstanceKeys> {
    const keyPath = join(this.paths.keys, 'instance.key');
    const idPath = join(this.paths.keys, 'instance.id');

    // Generate 32 bytes for private key (256-bit)
    const privateKey = randomBytes(32);
    const fingerprint = privateKey.subarray(0, 8).toString('hex');
    // Instance ID: workerId + timestamp + random suffix
    const instanceId = `${this.workerId}-${Date.now()}-${randomBytes(4).toString('hex')}`;

    // Persist to disk (hex-encoded for readability)
    await Promise.all([
      writeFile(keyPath, privateKey.toString('hex'), { mode: 0o600 }),
      writeFile(idPath, instanceId, { mode: 0o600 }),
    ]);

    return { privateKey, instanceId, fingerprint };
  }

  /**
   * Get instance keys (throws if not initialized)
   */
  async getInstanceKeys(): Promise<InstanceKeys> {
    if (!this.initialized) {
      throw new Error('Sandbox not initialized - call initialize() first');
    }
    return this.getOrCreateInstanceKeys();
  }

  /**
   * Get path for a session file
   */
  getSessionPath(sessionId: string): string {
    // Sanitize session ID to prevent path traversal
    const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return join(this.paths.sessions, `${safeId}.json`);
  }

  /**
   * Get path for a temp file
   */
  getTempPath(filename: string): string {
    const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    return join(this.paths.temp, safeFilename);
  }

  /**
   * Get path for a cache file
   */
  getCachePath(key: string): string {
    const safeKey = key.replace(/[^a-zA-Z0-9._-]/g, '_');
    return join(this.paths.cache, safeKey);
  }

  /**
   * Get path for a state file
   */
  getStatePath(name: string): string {
    const safeName = name.replace(/[^a-zA-Z0-9._-]/g, '_');
    return join(this.paths.state, `${safeName}.json`);
  }

  /**
   * Get path for a log file
   */
  getLogPath(name: string): string {
    const safeName = name.replace(/[^a-zA-Z0-9._-]/g, '_');
    return join(this.paths.logs, `${safeName}.log`);
  }

  /**
   * Read state from a state file
   */
  async readState<T>(name: string): Promise<T | null> {
    try {
      const path = this.getStatePath(name);
      const content = await readFile(path, 'utf-8');
      return JSON.parse(content) as T;
    } catch {
      return null;
    }
  }

  /**
   * Write state to a state file
   */
  async writeState<T>(name: string, data: T): Promise<void> {
    const path = this.getStatePath(name);
    await writeFile(path, JSON.stringify(data, null, 2));
  }

  /**
   * Check if sandbox exists
   */
  async exists(): Promise<boolean> {
    try {
      const stats = await stat(this.paths.root);
      return stats.isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * Clear temporary files
   */
  async clearTemp(): Promise<void> {
    await rm(this.paths.temp, { recursive: true, force: true });
    await mkdir(this.paths.temp, { recursive: true });
  }

  /**
   * Clear cache files
   */
  async clearCache(): Promise<void> {
    await rm(this.paths.cache, { recursive: true, force: true });
    await mkdir(this.paths.cache, { recursive: true });
  }

  /**
   * Destroy the entire sandbox
   */
  async destroy(): Promise<void> {
    await rm(this.paths.root, { recursive: true, force: true });
    this.initialized = false;
  }

  /**
   * Get sandbox disk usage (rough estimate)
   */
  async getDiskUsage(): Promise<SandboxDiskUsage> {
    const usage: SandboxDiskUsage = {
      sessions: 0,
      temp: 0,
      cache: 0,
      state: 0,
      logs: 0,
      total: 0,
    };

    const getDirSize = async (dir: string): Promise<number> => {
      try {
        const { stdout } = await import('node:child_process').then((cp) =>
          new Promise<{ stdout: string }>((resolve, reject) => {
            cp.exec(`du -sb "${dir}" 2>/dev/null || echo "0"`, (err, stdout) => {
              if (err) reject(err);
              else resolve({ stdout });
            });
          })
        );
        const size = parseInt(stdout.split('\t')[0], 10);
        return isNaN(size) ? 0 : size;
      } catch {
        return 0;
      }
    };

    const [sessions, temp, cache, state, logs] = await Promise.all([
      getDirSize(this.paths.sessions),
      getDirSize(this.paths.temp),
      getDirSize(this.paths.cache),
      getDirSize(this.paths.state),
      getDirSize(this.paths.logs),
    ]);

    usage.sessions = sessions;
    usage.temp = temp;
    usage.cache = cache;
    usage.state = state;
    usage.logs = logs;
    usage.total = sessions + temp + cache + state + logs;

    return usage;
  }

  /**
   * Get environment variables for isolated execution.
   * Provides full credential and config isolation per worker.
   */
  getEnvironment(): Record<string, string> {
    return {
      // Worker identification
      MOLTBOT_WORKER_ID: this.workerId,
      MOLTBOT_SANDBOX_ROOT: this.paths.root,

      // Storage paths
      MOLTBOT_SESSIONS_DIR: this.paths.sessions,
      MOLTBOT_TEMP_DIR: this.paths.temp,
      MOLTBOT_CACHE_DIR: this.paths.cache,
      MOLTBOT_STATE_DIR: this.paths.state,
      MOLTBOT_LOGS_DIR: this.paths.logs,

      // Credential and config isolation (critical for multi-instance)
      MOLTBOT_CREDENTIALS_DIR: this.paths.credentials,
      MOLTBOT_CONFIG_DIR: this.paths.config,
      MOLTBOT_KEYS_DIR: this.paths.keys,

      // Override standard paths to isolate credentials
      CLAWDBOT_OAUTH_DIR: this.paths.credentials,
      XDG_CONFIG_HOME: this.paths.config,
      XDG_DATA_HOME: this.paths.state,
      XDG_CACHE_HOME: this.paths.cache,
      TMPDIR: this.paths.temp,
    };
  }

  /**
   * Get path for credential file
   */
  getCredentialPath(name: string): string {
    const safeName = name.replace(/[^a-zA-Z0-9._-]/g, '_');
    return join(this.paths.credentials, safeName);
  }

  /**
   * Get path for config file
   */
  getConfigPath(name: string): string {
    const safeName = name.replace(/[^a-zA-Z0-9._-]/g, '_');
    return join(this.paths.config, safeName);
  }
}

/** Disk usage breakdown */
export interface SandboxDiskUsage {
  sessions: number;
  temp: number;
  cache: number;
  state: number;
  logs: number;
  total: number;
}

/**
 * Sandbox manager - creates and manages sandboxes for workers
 */
export class SandboxManager {
  private sandboxes = new Map<WorkerId, WorkerSandbox>();
  private baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  /**
   * Get or create sandbox for a worker
   */
  async getSandbox(workerId: WorkerId): Promise<WorkerSandbox> {
    let sandbox = this.sandboxes.get(workerId);
    if (!sandbox) {
      sandbox = new WorkerSandbox(workerId, this.baseDir);
      await sandbox.initialize();
      this.sandboxes.set(workerId, sandbox);
    }
    return sandbox;
  }

  /**
   * Remove sandbox for a worker
   */
  async removeSandbox(workerId: WorkerId, destroy = false): Promise<void> {
    const sandbox = this.sandboxes.get(workerId);
    if (sandbox) {
      if (destroy) {
        await sandbox.destroy();
      }
      this.sandboxes.delete(workerId);
    }
  }

  /**
   * Get all sandboxes
   */
  getSandboxes(): Map<WorkerId, WorkerSandbox> {
    return new Map(this.sandboxes);
  }

  /**
   * Initialize base directory
   */
  async initialize(): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });
  }

  /**
   * Clean up old/unused sandboxes
   */
  async cleanup(maxAge: number): Promise<WorkerId[]> {
    const { readdir } = await import('node:fs/promises');
    const cleaned: WorkerId[] = [];
    const now = Date.now();

    try {
      const entries = await readdir(this.baseDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const workerId = entry.name;
        const sandbox = new WorkerSandbox(workerId, this.baseDir);
        const metadata = await sandbox.getMetadata();

        if (metadata && now - metadata.lastAccessed > maxAge) {
          await sandbox.destroy();
          this.sandboxes.delete(workerId);
          cleaned.push(workerId);
        }
      }
    } catch {
      // Directory might not exist yet
    }

    return cleaned;
  }
}
