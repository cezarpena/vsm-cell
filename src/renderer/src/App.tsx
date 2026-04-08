import React, { useState, useEffect } from 'react'
import Sidebar from './components/Sidebar'
import ProjectView from './components/ProjectView'
import ChatView from './components/ChatView'
import NetworkView from './components/NetworkView'
import FrictionBar from './components/FrictionBar'
import { Message, HKGStatus, IngestionProgress, FrictionAlert, PulseScope } from './types'

const App: React.FC = () => {
  const [view, setView] = useState<'project' | 'chat' | 'network'>('project')
  const [status, setStatus] = useState<HKGStatus | null>(null)
  const [topology, setTopology] = useState<any>(null)
  const [messages, setMessages] = useState<Message[]>([
    { role: 'system', content: 'App initialized. Ready.' }
  ])
  const [input, setInput] = useState('')
  const [isAsking, setIsAsking] = useState(false)
  const [ingestionProgress, setIngestionProgress] = useState<IngestionProgress | null>(null)
  const [summaryContent, setSummaryContent] = useState<string>('')
  const [alerts, setAlerts] = useState<FrictionAlert[]>([])
  const [agents, setAgents] = useState<Array<{ id: string; name?: string }>>([])
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  const [agentsError, setAgentsError] = useState<string | null>(null)
  const [agentsLoading, setAgentsLoading] = useState(false)
  const [renderError, setRenderError] = useState<string | null>(null)

  useEffect(() => {
    console.log('[App] Mounted');
    if (!(window as any).vsmAPI) {
      console.error('[App] window.vsmAPI is missing!');
      return;
    }

    const fetchStatus = () => {
      (window as any).vsmAPI.getHKGStatus()
        .then(res => setStatus(res))
        .catch(err => console.error('Failed to fetch status:', err));

      (window as any).vsmAPI.getTopology()
        .then(res => setTopology(res))
        .catch(err => console.error('Failed to fetch topology:', err));
    }
    
    fetchStatus();
    const interval = setInterval(fetchStatus, 15000);

    (window as any).vsmAPI.getSummary()
      .then(res => setSummaryContent(res?.summaryContent || ''))
      .catch(() => {});

    const loadAgents = () => {
      setAgentsLoading(true);
      (window as any).vsmAPI.openclawAgentsList()
        .then((list: any) => {
          if (Array.isArray(list) && list.length > 0) {
            setAgents(list);
            setAgentsError(null);
          } else {
            setAgents([]);
            setAgentsError('No OpenClaw agents found.');
          }
        })
        .catch((err) => {
          setAgents([]);
          setAgentsError(err?.message || 'Failed to load OpenClaw agents.');
        })
        .finally(() => setAgentsLoading(false));
    };
    loadAgents();

    (window as any).vsmAPI.openclawAgentGet()
      .then((current: any) => setSelectedAgentId(typeof current === 'string' ? current : null))
      .catch(() => setSelectedAgentId(null));

    const removeSummaryListener = (window as any).vsmAPI.onSummaryUpdated((data: any) => {
      if (typeof data?.summaryContent === 'string') {
        setSummaryContent(data.summaryContent);
      }
    });

    const removeReflexListener = (window as any).vsmAPI.onReflexAlert((_event, message: string) => {
      const type = message.startsWith('S3') ? 'S3' : 'S2';
      setAlerts(prev => [{
        id: Math.random().toString(36).substr(2, 9),
        type,
        message,
        timestamp: Date.now()
      }, ...prev]);
    })

    const removeIngestionListener = (window as any).vsmAPI.onIngestionProgress((progress: IngestionProgress) => {
      setIngestionProgress(progress);
      if (progress.status === 'COMPLETED' || progress.status === 'ERROR') {
        setTimeout(() => setIngestionProgress(null), 3000);
      }
    });

    const removeP2PListener = (window as any).vsmAPI.onP2PMessage((data: any) => {
      const { message } = data;
      if (!message || !message.payload) return;
      setMessages(prev => [...prev, { 
        role: message.type === 'REPORT' ? 'agent' : 'system', 
        content: `[P2P ${message.type}] from REMOTE: ${message.payload.text_content || 'Empty message'}`,
        scope: message.scope,
        target: message.target_cell
      }]);
    });

    return () => {
      clearInterval(interval);
      if (typeof removeReflexListener === 'function') try { removeReflexListener(); } catch(e) {}
      if (typeof removeIngestionListener === 'function') try { removeIngestionListener(); } catch(e) {}
      if (typeof removeP2PListener === 'function') try { removeP2PListener(); } catch(e) {}
      if (typeof removeSummaryListener === 'function') try { removeSummaryListener(); } catch(e) {}
    }
  }, [])

  const handleSelectDir = async () => {
    try {
      const newDir = await (window as any).vsmAPI.selectDirectory();
      if (newDir) {
        setMessages(prev => [...prev, { role: 'system', content: `Environment switched to: ${newDir}` }]);
        const res = await (window as any).vsmAPI.getHKGStatus();
        setStatus(res);
      }
    } catch (err) {
      console.error('Failed to select directory:', err);
    }
  }

  const handleAsk = async (scope: PulseScope = 'LOCAL', target?: string) => {
    if (!input.trim() || isAsking) return
    const userMsg = input.trim()
    setMessages(prev => [...prev, { role: 'user', content: userMsg, scope, target }])
    setInput('')
    
    if (scope === 'LOCAL') {
      setIsAsking(true)
      try {
        const response = await (window as any).vsmAPI.askAgent(userMsg)
        setMessages(prev => [...prev, { role: 'agent', content: response.content, citations: response.citations }]);
      } catch (error) {
        setMessages(prev => [...prev, { 
          role: 'system', 
          content: `Operational Error: ${error instanceof Error ? error.message : String(error)}` 
        }])
      } finally {
        setIsAsking(false)
      }
    } else if (scope === 'REMOTE' && target) {
      setMessages(prev => [...prev, { role: 'system', content: `Sending to ${target}...` }]);
      await (window as any).vsmAPI.remote(target, 'QUERY', { text_content: userMsg });
    }
  }

  const handleSelectAgent = async (agentId: string | null) => {
    setSelectedAgentId(agentId);
    try {
      await (window as any).vsmAPI.openclawAgentSet(agentId);
    } catch (err) {
      console.error('Failed to set agent:', err);
    }
  }

  const handleRefreshAgents = () => {
    setAgentsLoading(true);
    (window as any).vsmAPI.openclawAgentsList()
      .then((list: any) => {
        setAgents(Array.isArray(list) ? list : []);
        setAgentsError(Array.isArray(list) && list.length > 0 ? null : 'No agents found.');
      })
      .catch((err) => setAgentsError(err?.message || 'Load failed'))
      .finally(() => setAgentsLoading(false));
  }

  const dismissAlert = (id: string) => {
    setAlerts(prev => prev.filter(a => a.id !== id));
  }

  if (renderError) {
    return <div style={{ color: 'red', padding: '20px' }}>Render Crash: {renderError}</div>;
  }

  try {
    return (
      <div className="flex h-screen w-screen bg-[#0d1117] text-[#c9d1d9] overflow-hidden border border-[#30363d]">
        <Sidebar currentView={view} setView={setView} status={status ? 'online' : 'offline'} />
        <main className="flex-1 h-full min-h-0 flex flex-col relative overflow-hidden">
          {view === 'project' && (
            <ProjectView 
              status={status} 
              onSelectDir={handleSelectDir} 
              ingestionProgress={ingestionProgress}
              summaryContent={summaryContent}
            />
          )}
          {view === 'chat' && (
            <ChatView 
              messages={messages} input={input} setInput={setInput} onAsk={handleAsk} isAsking={isAsking}
              peers={status?.peers || []} peerId={status?.peerId} topology={topology} agents={agents} selectedAgentId={selectedAgentId}
              onSelectAgent={handleSelectAgent} onRefreshAgents={handleRefreshAgents}
              agentsError={agentsError} agentsLoading={agentsLoading}
            />
          )}
          {view === 'network' && <NetworkView status={status} />}
          <FrictionBar alerts={alerts} onDismiss={dismissAlert} />
        </main>
      </div>
    )
  } catch (err: any) {
    setRenderError(err?.message || String(err));
    return null;
  }
}

export default App
