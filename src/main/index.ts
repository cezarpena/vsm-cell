import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { IngestionOrchestrator } from './ingestion/orchestrator.js'
import { AgenticController, listOpenclawAgents } from './services/agent.js'
import { P2PService } from './services/p2p.js'
import { TorService } from './services/tor.js'
import * as dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
import fs from 'fs'
import chokidar from 'chokidar'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

dotenv.config()

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception in main process:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection in main process:', reason);
});

const userDataOverride = process.env.VSM_USER_DATA_DIR || process.env.VSM_USERDATA_DIR;
if (userDataOverride) {
  app.setPath('userData', path.resolve(userDataOverride));
}

const configPath = join(app.getPath('userData'), 'vsm_config.json');
let lastWatchDir = '';
try {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  lastWatchDir = config.lastWatchDir;
} catch (e) {}

let currentWatchDir = lastWatchDir || process.env.VSM_WATCH_DIR || process.env.WATCH_DIR;
const watchDirArg = process.argv.find(arg => arg.startsWith('--vsm-watch-dir='));
if (watchDirArg) {
  currentWatchDir = watchDirArg.split('=')[1];
} else if (!currentWatchDir) {
  currentWatchDir = join(app.getPath('userData'), 'watch');
}
if (!fs.existsSync(currentWatchDir)) {
  fs.mkdirSync(currentWatchDir, { recursive: true });
}

const saveConfig = (dir: string) => {
  try {
    fs.writeFileSync(configPath, JSON.stringify({ lastWatchDir: dir }));
  } catch (e) {
    console.error('Failed to save config:', e);
  }
};

let mainWindow: BrowserWindow | null = null;
let creatingWindow = false;
const orchestrator = new IngestionOrchestrator();
let torService: TorService | null = null;
let p2p: P2PService | null = null;
let agent: AgenticController | null = null;
let ipcHandlersRegistered = false;
let servicesInitializing = false;
let cachedSummary = '';
let cachedSummaryPath = '';
let cachedSummaryMtime = 0;
let summaryWatcher: chokidar.FSWatcher | null = null;

const openclawBin = resolveBundledOpenclaw();
if (openclawBin) {
  process.env.OPENCLAW_BIN = openclawBin;
}

const sendProgress = (p: any) => {
  if (mainWindow) {
    mainWindow.webContents.send('ingestion:progress', p);
  }
};

function registerIpcHandlers() {
  ipcMain.handle('dir:select', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ['openDirectory']
    });
    if (!canceled) {
      const newDir = filePaths[0];
      await orchestrator.stop();
      await orchestrator.start(newDir, sendProgress);
      currentWatchDir = newDir;
      saveConfig(newDir);
      if (agent) agent.setWatchDir(newDir);
      await startSummaryWatcher();
      return newDir;
    }
    return null;
  });

  ipcMain.handle('agent:ask', async (_event, query: string) => {
    if (!agent) {
      return { content: 'Agent not ready yet.', status: 'VETO' };
    }
    return await agent.process(query, currentWatchDir);
  });

  ipcMain.handle('openclaw:agents:list', async () => {
    try {
      if (agent) return agent.listAgents();
      return await listOpenclawAgents();
    } catch (e) {
      return [];
    }
  });

  ipcMain.handle('openclaw:agent:get', async () => {
    if (!agent) return null;
    return agent.getAgentId();
  });

  ipcMain.handle('openclaw:agent:set', async (_event, { agentId }) => {
    if (!agent) return { success: false };
    agent.setAgentId(agentId ?? null);
    return { success: true };
  });

  ipcMain.handle('db:status', async () => {
    return {
      status: 'ACTIVE',
      peerId: p2p?.getPeerId() ?? 'initializing',
      project: 'VSM-Cell Default',
      peers: p2p?.getPeers() ?? [],
      watchDir: currentWatchDir,
      totalTokens: orchestrator.getTotalTokens(),
      tor: torService?.getStatus()
    };
  });

  ipcMain.handle('summary:get', async () => {
    await refreshSummaryCache();
    return { summaryContent: cachedSummary };
  });

  ipcMain.handle('p2p:remote', async (_event, { target, type, payload }) => {
    if (!p2p) throw new Error('P2P not ready');
    await p2p.remote(target, type, payload);
    return { success: true };
  });

  ipcMain.handle('p2p:invite:generate', async (_event, { type, role, inviteePeerId }) => {
    if (!p2p) throw new Error('P2P not ready');
    return await p2p.generateInvite(type, role, inviteePeerId);
  });

  ipcMain.handle('p2p:join', async (_event, { token }) => {
    try {
      if (!p2p) throw new Error('P2P not ready');
      await p2p.joinMesh(token);
      return { success: true };
    } catch (e: any) {
      console.error('Join mesh failed:', e?.stack || e);
      return { success: false, error: e?.message || String(e) };
    }
  });

  ipcMain.handle('p2p:display_name:set', async (_event, { name }) => {
    if (!p2p) throw new Error('P2P not ready');
    await p2p.setDisplayName(name);
    return { success: true };
  });

  ipcMain.handle('p2p:leave', async () => {
    if (!p2p) throw new Error('P2P not ready');
    await p2p.leaveMesh();
    return { success: true };
  });

  ipcMain.handle('vsm:topology', async () => {
    return p2p?.getTopology() ?? { level: 0, role: 'INIT', displayName: 'Initializing', parent: null, children: [], peers: [] };
  });

  ipcMain.handle('vsm:full_topology', async () => {
    return p2p?.getFullTopology() ?? {};
  });

  ipcMain.handle('app:platform', async () => {
    return process.platform;
  });
}

async function createWindow(): Promise<void> {
  if (mainWindow) {
    mainWindow.focus();
    return;
  }
  if (creatingWindow) return;
  creatingWindow = true;

  try {
    const platform = process.platform;
    const arch = process.arch;
    const torBinName = platform === 'win32' ? 'tor.exe' : 'tor';
    const torDirCandidates = [
      app.isPackaged
        ? path.join(process.resourcesPath, 'tor', `${platform}-${arch}`)
        : path.join(app.getAppPath(), 'resources', 'tor', `${platform}-${arch}`),
      app.isPackaged
        ? path.join(process.resourcesPath, 'tor', platform)
        : path.join(app.getAppPath(), 'resources', 'tor', platform)
    ];
    const torBinPath = torDirCandidates
      .map(dir => path.join(dir, 'tor', torBinName))
      .find(p => fs.existsSync(p));

    // Support port override for multi-node testing
    let vsmPort = 4001;
    const portArg = process.argv.find(arg => arg.startsWith('--vsm-port='));
    if (portArg) {
      vsmPort = parseInt(portArg.split('=')[1]);
    } else if (process.env.VSM_PORT) {
      vsmPort = parseInt(process.env.VSM_PORT);
    }

    const torDataDir = path.join(app.getPath('userData'), 'tor');
    const localTorPort = vsmPort;
    const onionPort = vsmPort;

    // Fixed Tor initialization
    if (torBinPath && !torService) {
      const torBinDir = path.dirname(torBinPath);
      const torRootDir = path.dirname(torBinDir);
      const geoipPath = path.join(torRootDir, 'data', 'geoip');
      const geoip6Path = path.join(torRootDir, 'data', 'geoip6');
      const torLogPath = path.join(torDataDir, 'tor.log');

      torService = new TorService({
        torBinPath,
        dataDir: torDataDir,
        localPort: localTorPort,
        onionPort,
        geoipPath: fs.existsSync(geoipPath) ? geoipPath : undefined,
        geoip6Path: fs.existsSync(geoip6Path) ? geoip6Path : undefined,
        logPath: torLogPath
      });
    }

    mainWindow = new BrowserWindow({
      width: 900,
      height: 670,
      show: false,
      autoHideMenuBar: true,
      webPreferences: {
        preload: join(__dirname, '../preload/index.mjs'),
        sandbox: false
      }
    });

    mainWindow.on('ready-to-show', () => {
      if (mainWindow) mainWindow.show();
    });

    mainWindow.on('closed', () => {
      mainWindow = null;
    });

    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
    } else {
      mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
    }

    if (!servicesInitializing) {
      servicesInitializing = true;
      setTimeout(() => {
        void initializeServices(torBinPath, torDataDir, localTorPort, onionPort);
      }, 500);
    }
  } finally {
    creatingWindow = false;
  }
}

async function refreshSummaryCache(): Promise<void> {
  const summaryPath = path.join(currentWatchDir, 'VSM_SUMMARY.md');
  try {
    if (fs.existsSync(summaryPath)) {
      const stat = fs.statSync(summaryPath);
      if (summaryPath !== cachedSummaryPath || stat.mtimeMs !== cachedSummaryMtime) {
        cachedSummary = fs.readFileSync(summaryPath, 'utf-8');
        cachedSummaryPath = summaryPath;
        cachedSummaryMtime = stat.mtimeMs;
      }
    }
  } catch (e) {}
}

async function startSummaryWatcher(): Promise<void> {
  const summaryPath = path.join(currentWatchDir, 'VSM_SUMMARY.md');
  if (summaryWatcher) {
    await summaryWatcher.close();
  }

  summaryWatcher = chokidar.watch(summaryPath, {
    ignoreInitial: false,
    awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 100 }
  });

  summaryWatcher.on('all', async () => {
    await refreshSummaryCache();
    if (mainWindow) {
      mainWindow.webContents.send('summary:updated', { summaryContent: cachedSummary });
    }
  });
}

async function initializeServices(
  torBinPath: string | undefined,
  torDataDir: string,
  localTorPort: number,
  onionPort: number
): Promise<void> {
  try {
    await orchestrator.start(currentWatchDir, sendProgress);
    await startSummaryWatcher();
  } catch (e) {
    console.error('Failed to start Orchestrator:', e);
  }

  let identityPath = path.join(app.getPath('userData'), 'vsm_peer_id.json');
  const peerIdArg = process.argv.find(arg => arg.startsWith('--vsm-peer-id='));
  const peerIdEnv = process.env.VSM_PEER_ID;
  const peerIdSource = peerIdArg ? peerIdArg.split('=')[1] : peerIdEnv;
  if (peerIdSource) {
    identityPath = peerIdSource;
    if (!path.isAbsolute(identityPath)) {
      identityPath = path.join(process.cwd(), identityPath);
    }
  }
  let torConfig: any;

  if (torService && torBinPath) {
    try {
      const { onionHost, socksPort } = await torService.start();
      torConfig = { enabled: true, socksHost: '127.0.0.1', socksPort, onionHost, onionPort, localPort: localTorPort };
    } catch (e: any) {
      console.error('Tor Service start failed:', e);
    }
  }

  p2p = new P2PService(undefined, identityPath, false, torConfig);
  agent = new AgenticController(p2p, { openclawBin: openclawBin });
  agent.setWatchDir(currentWatchDir);

  try {
    await p2p.start();
  } catch (e) {
    console.error('P2P Service start failed:', e);
  }

  p2p.onMessage((topic, message) => {
    if (mainWindow) {
      mainWindow.webContents.send('p2p:message', { topic, message });
    }
  });
}

const skipLock = process.argv.includes('--multi-instance') || process.env.VSM_MULTI_INSTANCE === '1' || process.env.VSM_MULTI_INSTANCE === 'true';
const gotLock = skipLock || app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  if (!skipLock) {
    app.on('second-instance', () => {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
      }
    });
  }

  app.whenReady().then(() => {
    electronApp.setAppUserModelId('com.vsm.cell')
    if (!ipcHandlersRegistered) {
      registerIpcHandlers();
      ipcHandlersRegistered = true;
    }
    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })
    createWindow()
    app.on('activate', function () {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    torService?.stop().catch(() => {});
    app.quit()
  }
})

function resolveBundledOpenclaw(): string | undefined {
  const candidates = [
    path.join(app.getAppPath(), 'node_modules', 'openclaw', 'openclaw.mjs'),
    path.join(process.cwd(), 'node_modules', 'openclaw', 'openclaw.mjs')
  ];
  return candidates.find((p) => fs.existsSync(p));
}
