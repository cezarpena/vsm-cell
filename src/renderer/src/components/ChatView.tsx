import React, { useRef, useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Message, PulseScope } from '../types';

interface ChatViewProps {
  messages: Message[];
  input: string;
  setInput: (input: string) => void;
  onAsk: (scope: PulseScope, target?: string) => void;
  isAsking: boolean;
  peers: string[];
  peerId?: string;
  topology?: any;
  agents: Array<{ id: string; name?: string }>;
  selectedAgentId: string | null;
  onSelectAgent: (agentId: string | null) => void;
  onRefreshAgents: () => void;
  agentsError: string | null;
  agentsLoading: boolean;
}

const ChatView: React.FC<ChatViewProps> = ({ messages, input, setInput, onAsk, isAsking, peers, peerId, topology, agents, selectedAgentId, onSelectAgent, onRefreshAgents, agentsError, agentsLoading }) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scope, setScope] = useState<PulseScope>('LOCAL');
  const [target, setTarget] = useState<string>('');
  const [fullTopology, setFullTopology] = useState<any>({});
  const [showMap, setShowMap] = useState(false);

  useEffect(() => {
    const fetchFullTopology = async () => {
      if (window.vsmAPI?.getFullTopology) {
        const ft = await window.vsmAPI.getFullTopology();
        setFullTopology(ft);
      }
    };
    fetchFullTopology();
    const interval = setInterval(fetchFullTopology, 2000);
    return () => clearInterval(interval);
  }, []);

  const labelFor = (id?: string) => {
    if (!id || !topology) return 'NODE';
    const other = fullTopology[id];
    if (other?.displayName) return other.displayName;
    if (topology.parent === id) return 'PARENT';
    const peerIdx = topology.peers?.indexOf(id);
    if (peerIdx != null && peerIdx >= 0) return `PEER ${peerIdx + 1}`;
    const childIdx = topology.children?.indexOf(id);
    if (childIdx != null && childIdx >= 0) return `CHILD ${childIdx + 1}`;
    return id.substring(0, 8);
  };

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleExecute = () => {
    if (!input.trim() || isAsking) return;
    onAsk(scope, target);
  };

  const handleNodeClick = (id: string, isSelf: boolean) => {
    if (isSelf) {
      setScope('LOCAL');
      setTarget('');
    } else {
      setScope('REMOTE');
      setTarget(id);
    }
  };

  const renderTopologyMap = () => {
    const nodes = Object.keys(fullTopology);
    if (nodes.length === 0) return null;

    return (
      <div className="absolute top-20 right-8 z-10 w-64 p-4 bg-[#161b22] border border-[#30363d] rounded-sm shadow-2xl space-y-4">
        <div className="flex justify-between items-center border-b border-[#30363d] pb-2">
          <h3 className="text-[10px] uppercase tracking-widest text-[#8b949e]">Visual Mesh Map</h3>
          <button onClick={() => setShowMap(false)} className="text-[#8b949e] hover:text-[#c9d1d9] text-xs">×</button>
        </div>
        <div className="space-y-2 max-h-60 overflow-y-auto pr-2 custom-scrollbar">
          {nodes.map(id => {
            const nodeInfo = fullTopology[id];
            const isSelf = id === peerId;
            const isSelected = (scope === 'REMOTE' && target === id) || (isSelf && scope === 'LOCAL');
            
            return (
              <div 
                key={id}
                onClick={() => handleNodeClick(id, isSelf)}
                className={`p-2 border transition-all cursor-pointer group flex flex-col ${
                  isSelected 
                  ? 'bg-[#21262d] border-[#58a6ff]' 
                  : 'bg-[#0d1117] border-[#30363d] hover:border-[#8b949e]'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className={`text-[10px] font-bold ${isSelf ? 'text-[#3fb950]' : 'text-[#c9d1d9]'}`}>
                    {nodeInfo?.displayName || 'Anonymous'} {isSelf && '(YOU)'}
                  </span>
                  <div className={`w-2 h-2 rounded-full ${isSelected ? 'bg-[#58a6ff] animate-pulse' : 'bg-[#30363d]'}`} />
                </div>
                <span className="text-[9px] font-mono text-[#8b949e] truncate">{id}</span>
                <span className="text-[9px] text-[#58a6ff] mt-1">Level {nodeInfo?.level} - {nodeInfo?.role}</span>
              </div>
            );
          })}
        </div>
        <p className="text-[9px] text-[#8b949e] italic">Click a node to target via REMOTE.</p>
      </div>
    );
  };


  return (
    <div className="flex-1 h-full min-h-0 flex flex-col relative bg-[#0d1117] overflow-hidden">
      {/* Map Overlay */}
      {showMap && renderTopologyMap()}

      {/* Message View */}
      <div 
        ref={scrollRef}
        className="flex-1 overflow-y-auto p-8 space-y-12 min-h-0"
      >
        <div className="max-w-3xl mx-auto w-full space-y-8">
          {messages.map((m, i) => (
            <div key={i} className={`flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'}`}>
              <div className={`max-w-[95%] p-4 rounded-sm text-sm whitespace-pre-wrap transition-all ${
                m.role === 'user' ? 'bg-[#21262d] border border-[#30363d] text-[#c9d1d9]' : 
                m.role === 'agent' ? 'bg-transparent text-[#c9d1d9] prose prose-invert prose-sm max-w-none' : 
                'bg-transparent text-[#8b949e] italic text-xs border-l border-[#30363d] pl-4'
              }`}>
              {m.scope && m.scope !== 'LOCAL' && (
                <div className="text-[10px] font-mono text-[#58a6ff] mb-2 border-b border-[#30363d] pb-1">
                  SCOPE: {m.scope} {m.target ? `(TO: ${labelFor(m.target)})` : ''}
                </div>
              )}
                {m.role === 'agent' ? (
                  <div className="markdown-container">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                  </div>
                ) : (
                  m.content
                )}
              </div>
              <span className="text-[10px] mt-2 text-[#8b949e] font-mono uppercase tracking-tighter opacity-50">
                {m.role}
              </span>
            </div>
          ))}
          {isAsking && (
            <div className="flex flex-col items-start">
              <div className="max-w-[95%] p-4 rounded-sm text-sm whitespace-pre-wrap transition-all bg-transparent text-[#8b949e] italic text-xs border-l border-[#30363d] pl-4">
                OpenClaw is working...
              </div>
              <span className="text-[10px] mt-2 text-[#8b949e] font-mono uppercase tracking-tighter opacity-50">
                system
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Control Bar */}
      <div className="px-8 py-2 border-t border-[#30363d] bg-[#0d1117] flex gap-4 items-center overflow-x-auto min-h-[48px]">
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[10px] font-mono text-[#8b949e]">AGENT:</span>
          <select
            className="text-[10px] font-mono bg-[#0d1117] border border-[#30363d] text-[#c9d1d9] px-2 py-1"
            value={selectedAgentId ?? ''}
            onChange={(e) => onSelectAgent(e.target.value || null)}
          >
            <option value="">default</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name ? `${agent.name} (${agent.id})` : agent.id}
              </option>
            ))}
          </select>
        </div>
        {agentsError && (
          <span className="text-[10px] font-mono text-[#d29922] shrink-0">{agentsError}</span>
        )}
        <span className="text-[10px] font-mono text-[#8b949e] shrink-0">SCOPE:</span>
        <div className="flex gap-2">
          {(['LOCAL', 'REMOTE'] as PulseScope[]).map((s) => (
            <button
              key={s}
              onClick={() => setScope(s)}
              className={`text-[10px] font-mono px-2 py-1 border transition-all ${
                scope === s 
                ? 'bg-[#58a6ff] text-[#0d1117] border-[#58a6ff]' 
                : 'bg-transparent text-[#8b949e] border-[#30363d] hover:border-[#58a6ff]'
              }`}
            >
              {s}
            </button>
          ))}
        </div>

        <button 
          onClick={() => setShowMap(!showMap)}
          className={`text-[10px] font-mono px-3 py-1 border transition-all flex items-center gap-2 ${
            showMap ? 'bg-[#3fb950] text-[#0d1117] border-[#3fb950]' : 'bg-transparent text-[#3fb950] border-[#30363d] hover:border-[#3fb950]'
          }`}
        >
          <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />
          VIEW MESH MAP
        </button>

        {scope === 'REMOTE' && (
          <div className="flex gap-2 items-center ml-4 border-l border-[#30363d] pl-4 overflow-x-auto">
            <span className="text-[10px] font-mono text-[#8b949e] shrink-0">TARGET:</span>
            
            {topology?.parent && (
              <button
                onClick={() => setTarget(topology.parent)}
                className={`text-[10px] font-mono px-2 py-1 border transition-all flex items-center gap-1 shrink-0 ${
                  target === topology.parent 
                  ? 'bg-[#d2a8ff] text-[#0d1117] border-[#d2a8ff]' 
                  : 'bg-transparent text-[#d2a8ff] border-[#30363d] hover:border-[#d2a8ff]'
                }`}
                title="Parent Node"
              >
                <span>↑</span> PARENT
              </button>
            )}

            {topology?.peers?.map((p: string) => (
              <button
                key={p}
                onClick={() => setTarget(p)}
                className={`text-[10px] font-mono px-2 py-1 border transition-all flex items-center gap-1 shrink-0 ${
                  target === p 
                  ? 'bg-[#58a6ff] text-[#0d1117] border-[#58a6ff]' 
                  : 'bg-transparent text-[#58a6ff] border-[#30363d] hover:border-[#58a6ff]'
                }`}
                title="Peer Node"
              >
                <span>↔</span> {labelFor(p)}
              </button>
            ))}

            {topology?.children?.map((c: string) => (
              <button
                key={c}
                onClick={() => setTarget(c)}
                className={`text-[10px] font-mono px-2 py-1 border transition-all flex items-center gap-1 shrink-0 ${
                  target === c 
                  ? 'bg-[#3fb950] text-[#0d1117] border-[#3fb950]' 
                  : 'bg-transparent text-[#3fb950] border-[#30363d] hover:border-[#3fb950]'
                }`}
                title="Member Node"
              >
                <span>↓</span> {labelFor(c)}
              </button>
            ))}
            
            {(!topology?.parent && (!topology?.peers || topology.peers.length === 0) && (!topology?.children || topology.children.length === 0)) && (
              <span className="text-[10px] italic text-[#8b949e] shrink-0">No mapped nodes found.</span>
            )}
          </div>
        )}
      </div>

      {/* Input Bar */}
      <div className="p-8 border-t border-[#30363d] bg-[#0d1117] shrink-0">
        <div className="max-w-3xl mx-auto w-full flex gap-4">
          <input
            type="text"
            className="flex-1 cyber-input py-2 text-base"
            placeholder={scope === 'LOCAL' ? 'Ask OpenClaw...' : `Send to REMOTE target...`}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleExecute()}
            disabled={isAsking}
          />
          <button 
            className={`cyber-button px-6 font-bold tracking-widest ${isAsking ? 'opacity-50 cursor-not-allowed text-[#8b949e]' : 'text-[#58a6ff]'}`}
            onClick={handleExecute}
            disabled={isAsking}
          >
            {isAsking ? '...' : 'EXECUTE'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ChatView;
