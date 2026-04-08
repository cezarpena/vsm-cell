import { contextBridge, ipcRenderer } from 'electron'
import { exposeElectronAPI } from '@electron-toolkit/preload'

// Custom API for the VSM-Cell
const vsmAPI = {
  askAgent: (query: string) => ipcRenderer.invoke('agent:ask', query),
  openclawAgentsList: () => ipcRenderer.invoke('openclaw:agents:list'),
  openclawAgentGet: () => ipcRenderer.invoke('openclaw:agent:get'),
  openclawAgentSet: (agentId: string | null) => ipcRenderer.invoke('openclaw:agent:set', { agentId }),
  onReflexAlert: (callback) => ipcRenderer.on('alert:reflex', callback),
  getHKGStatus: () => ipcRenderer.invoke('db:status'),
  selectDirectory: () => ipcRenderer.invoke('dir:select'),
  onIngestionProgress: (callback) => ipcRenderer.on('ingestion:progress', (_event, progress) => callback(progress)),
  onSummaryUpdated: (callback) => ipcRenderer.on('summary:updated', (_event, data) => callback(data)),
  getSummary: () => ipcRenderer.invoke('summary:get'),
  remote: (target: string, type: string, payload: any) => 
    ipcRenderer.invoke('p2p:remote', { target, type, payload }),
  onP2PMessage: (callback: (data: any) => void) => 
    ipcRenderer.on('p2p:message', (_event, data) => callback(data)),
  generateInvite: (type: 'PEER' | 'MEMBER', role: string, inviteePeerId: string) => 
    ipcRenderer.invoke('p2p:invite:generate', { type, role, inviteePeerId }),
  joinMesh: (token: string) => 
    ipcRenderer.invoke('p2p:join', { token }),
  leaveMesh: () =>
    ipcRenderer.invoke('p2p:leave'),
  getTopology: () => 
    ipcRenderer.invoke('vsm:topology'),
  getFullTopology: () =>
    ipcRenderer.invoke('vsm:full_topology'),
  setDisplayName: (name: string) => 
    ipcRenderer.invoke('p2p:display_name:set', { name }),
  platform: () =>
    ipcRenderer.invoke('app:platform'),

}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    exposeElectronAPI()
    contextBridge.exposeInMainWorld('vsmAPI', vsmAPI)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = exposeElectronAPI()
  // @ts-ignore (define in dts)
  window.vsmAPI = vsmAPI
}
