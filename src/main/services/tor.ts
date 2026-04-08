import fs from 'fs/promises';
import path from 'path';
import net from 'net';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { EventEmitter } from 'events';

export type TorConfig = {
  torBinPath: string;
  dataDir: string;
  localPort: number;
  onionPort: number;
  socksPort?: number;
  geoipPath?: string;
  geoip6Path?: string;
  logPath?: string;
};

export type TorStatus = {
  state: 'starting' | 'running' | 'restarting' | 'stopped' | 'error';
  onionHost?: string;
  socksPort?: number;
  lastError?: string;
  lastExitCode?: number | null;
  lastExitSignal?: NodeJS.Signals | null;
  bootstrapped?: boolean;
};

export class TorService extends EventEmitter {
  private cfg: TorConfig;
  private proc?: ChildProcessWithoutNullStreams;
  private socksPort!: number;
  private hostnamePath: string;
  private status: TorStatus = { state: 'stopped' };
  private restartTimer?: NodeJS.Timeout;
  private restartAttempts = 0;
  private stopping = false;
  private bootstrapped = false;

  constructor(cfg: TorConfig) {
    super();
    this.cfg = cfg;
    this.hostnamePath = path.join(cfg.dataDir, 'hidden_service', 'hostname');
  }

  async start(): Promise<{ onionHost: string; socksPort: number }> {
    this.stopping = false;
    this.restartAttempts = 0;
    this.bootstrapped = false;
    try {
      await fs.access(this.cfg.torBinPath);
    } catch {
      const err = new Error(`Tor binary not found at ${this.cfg.torBinPath}`);
      this.setStatus({ state: 'error', lastError: err.message });
      throw err;
    }
    await fs.mkdir(this.cfg.dataDir, { recursive: true });
    await fs.mkdir(path.join(this.cfg.dataDir, 'hidden_service'), { recursive: true });
    try {
      await fs.chmod(this.cfg.dataDir, 0o700);
      await fs.chmod(path.join(this.cfg.dataDir, 'hidden_service'), 0o700);
    } catch {
      // best-effort: Tor will complain if perms are too open
    }

    this.socksPort = this.cfg.socksPort ?? (await this.findFreePort());
    this.setStatus({ state: 'starting', socksPort: this.socksPort });
    await this.spawnTor();

    const onionHost = await this.waitForHostname();
    await this.waitForBootstrap();
    this.setStatus({ state: 'running', onionHost, socksPort: this.socksPort, bootstrapped: true });
    return { onionHost, socksPort: this.socksPort };
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    if (this.proc) {
      this.proc.kill('SIGTERM');
      this.proc = undefined;
    }
    this.setStatus({ state: 'stopped', socksPort: this.socksPort });
  }

  getStatus(): TorStatus {
    return { ...this.status };
  }

  private async writeTorrc(): Promise<string> {
    const torrcPath = path.join(this.cfg.dataDir, 'torrc');
    const contents = [
      `SocksPort ${this.socksPort}`,
      `DataDirectory ${this.cfg.dataDir}`,
      `HiddenServiceDir ${path.join(this.cfg.dataDir, 'hidden_service')}`,
      `HiddenServiceVersion 3`,
      `HiddenServicePort ${this.cfg.onionPort} 127.0.0.1:${this.cfg.localPort}`,
      `Log notice stdout`,
      `Log err stderr`
    ];

    if (this.cfg.geoipPath) contents.push(`GeoIPFile ${this.cfg.geoipPath}`);
    if (this.cfg.geoip6Path) contents.push(`GeoIPv6File ${this.cfg.geoip6Path}`);
    
    // Add these to prevent common startup crashes on macOS
    contents.push(`AvoidDiskWrites 0`);

    const torrc = contents.join('\n');
    await fs.writeFile(torrcPath, torrc);
    return torrcPath;
  }

  private async spawnTor(): Promise<void> {
    const torrc = await this.writeTorrc();
    const env = { ...process.env };
    const torBinDir = path.dirname(this.cfg.torBinPath);
    
    if (process.platform === 'darwin') {
      env.DYLD_LIBRARY_PATH = [torBinDir, env.DYLD_LIBRARY_PATH].filter(Boolean).join(':');
    }

    this.proc = spawn(this.cfg.torBinPath, ['-f', torrc], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: torBinDir,
      env
    });

    this.proc.stdout.on('data', (d) => {
      const lines = d.toString('utf-8').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) {
          if (trimmed.includes('Bootstrapped 100%')) {
            this.bootstrapped = true;
            this.setStatus({ bootstrapped: true });
          }
          console.log(`[Tor] ${trimmed}`);
        }
      }
    });

    this.proc.stderr.on('data', (d) => {
      const lines = d.toString('utf-8').split('\n');
      for (const line of lines) {
        if (line.trim()) {
          console.error(`[Tor ERR] ${line.trim()}`);
          this.setStatus({ state: 'error', lastError: line.trim(), socksPort: this.socksPort });
        }
      }
    });

    this.proc.on('error', (err) => {
      console.error('[Tor SPAWN ERR]', err);
      this.setStatus({ state: 'error', lastError: err.message, socksPort: this.socksPort });
    });

    this.proc.on('exit', (code, signal) => {
      console.log(`[Tor EXIT] code=${code} signal=${signal}`);
      this.proc = undefined;
      if (this.stopping) {
        this.setStatus({ state: 'stopped', lastExitCode: code, lastExitSignal: signal, socksPort: this.socksPort });
        return;
      }
      this.scheduleRestart(code, signal);
    });
  }

  private scheduleRestart(code: number | null, signal: NodeJS.Signals | null): void {
    const backoffMs = Math.min(30_000, 1_000 * Math.max(1, ++this.restartAttempts));
    this.setStatus({
      state: 'restarting',
      lastExitCode: code,
      lastExitSignal: signal,
      socksPort: this.socksPort
    });
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      this.spawnTor().catch((e: any) => {
        this.setStatus({ state: 'error', lastError: e?.message || 'Tor restart failed', socksPort: this.socksPort });
      });
    }, backoffMs);
  }

  private setStatus(next: TorStatus): void {
    this.status = { ...this.status, ...next };
    this.emit('status', this.status);
  }

  private async waitForHostname(): Promise<string> {
    const maxWaitMs = 60_000;
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      if (!this.proc && !this.stopping) {
        const err = new Error('Tor process exited before hidden service hostname was created');
        this.setStatus({ state: 'error', lastError: err.message, socksPort: this.socksPort });
        throw err;
      }
      try {
        const raw = await fs.readFile(this.hostnamePath, 'utf-8');
        const host = raw.trim();
        if (host.endsWith('.onion')) return host;
      } catch {
        // wait
      }
      await new Promise(r => setTimeout(r, 250));
    }
    const err = new Error('Tor hidden service hostname not available');
    this.setStatus({ state: 'error', lastError: err.message, socksPort: this.socksPort });
    throw err;
  }

  private async waitForBootstrap(): Promise<void> {
    const maxWaitMs = 60_000;
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      if (!this.proc && !this.stopping) {
        const err = new Error('Tor process exited before bootstrapping');
        this.setStatus({ state: 'error', lastError: err.message, socksPort: this.socksPort });
        throw err;
      }
      if (this.bootstrapped) return;
      await new Promise(r => setTimeout(r, 250));
    }
    const err = new Error('Tor did not finish bootstrapping');
    this.setStatus({ state: 'error', lastError: err.message, socksPort: this.socksPort });
    throw err;
  }

  private async findFreePort(): Promise<number> {
    return await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          const port = addr.port;
          server.close(() => resolve(port));
        } else {
          server.close();
          reject(new Error('Unable to allocate port'));
        }
      });
      server.on('error', reject);
    });
  }
}
