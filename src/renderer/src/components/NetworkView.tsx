import React, { useState, useEffect } from 'react';
import { HKGStatus } from '../types';

interface NetworkViewProps {
  status: HKGStatus | null;
}

const NetworkView: React.FC<NetworkViewProps> = ({ status }) => {
  const [inviteToken, setInviteToken] = useState<string>('');
  const [joinToken, setJoinToken] = useState<string>('');
  const [topology, setTopology] = useState<any>(null);
  const [inviteType, setInviteType] = useState<'PEER' | 'MEMBER'>('MEMBER');
  const [inviteRole, setInviteRole] = useState<string>('');
  const [inviteePeerId, setInviteePeerId] = useState<string>('');
  const [displayName, setDisplayName] = useState<string>('');
  const [copied, setCopied] = useState(false);
  const [isJoining, setIsJoining] = useState(false);
  const [joinStatus, setJoinStatus] = useState<'idle' | 'connecting' | 'success' | 'failed'>('idle');
  const torState = status?.tor?.state || 'starting';
  const torColor =
    torState === 'running'
      ? 'text-[#3fb950]'
      : torState === 'error'
        ? 'text-[#f85149]'
        : torState === 'restarting'
          ? 'text-[#d29922]'
          : 'text-[#8b949e]';
  const [fullTopology, setFullTopology] = useState<any>({});
  
  const isAlreadyInMesh = !!(topology?.parent || (topology?.peers && topology.peers.length > 0) || (topology?.children && topology.children.length > 0));

  useEffect(() => {
    const refreshTopology = async () => {
      if (window.vsmAPI) {
        const t = await window.vsmAPI.getTopology();
        setTopology(t);
        if (t?.displayName) setDisplayName(t.displayName);
        
        // Use getFullTopology from preload context
        const ft = await window.vsmAPI.getFullTopology();
        setFullTopology(ft || {});
      }
    };

    refreshTopology();
    const interval = setInterval(refreshTopology, 5000);
    return () => clearInterval(interval);
  }, [status]);

  const handleUnicastTest = async (targetId: string) => {
    try {
      await window.vsmAPI.unicast(targetId, 'QUERY', { text_content: 'Are you active?' });
      alert(`Unicast pulse sent to ${targetId}`);
    } catch (e: any) {
      alert(`Failed to send unicast: ${e.message}`);
    }
  };

  const renderMeshNodes = () => {
    const entries = Object.entries(fullTopology);
    if (entries.length === 0) return (
      <div className="p-8 border border-dashed border-[#30363d] rounded-sm flex flex-col items-center justify-center space-y-2">
        <p className="text-xs text-[#8b949e] italic">No authorized cells discovered in mesh.</p>
      </div>
    );

    return (
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {entries.map(([peerId, topo]: [string, any]) => {
          const isSelf = peerId === status?.peerId;
          return (
            <div key={peerId} className={`p-4 bg-[#161b22] border ${isSelf ? 'border-[#58a6ff]' : 'border-[#30363d]'} rounded-sm space-y-3`}>
              <div className="flex justify-between items-start">
                <div className="flex items-center gap-2">
                  <div className={`w-2 h-2 rounded-full ${isSelf ? 'bg-[#58a6ff]' : 'bg-[#3fb950]'} animate-pulse`} />
                  <span className="text-[10px] font-bold text-[#c9d1d9] uppercase tracking-wider">
                    {topo.displayName || 'Anonymous Cell'} {isSelf && '(YOU)'}
                  </span>
                </div>
                <span className="text-[10px] font-mono text-[#8b949e]">LEVEL {topo.level}</span>
              </div>
              
              <div className="space-y-1">
                <p className="text-[10px] uppercase text-[#8b949e]">Role</p>
                <p className="text-xs text-[#c9d1d9] font-mono bg-[#0d1117] p-1 rounded-sm border border-[#30363d]">{topo.role || 'Unknown'}</p>
              </div>

              <div className="space-y-1">
                <p className="text-[10px] uppercase text-[#8b949e]">Peer ID</p>
                <p className="text-[9px] font-mono text-[#58a6ff] truncate">{peerId}</p>
              </div>

              {!isSelf && (
                <button 
                  onClick={() => handleUnicastTest(peerId)}
                  className="w-full mt-2 py-1 text-[10px] font-bold tracking-widest text-[#8b949e] border border-[#30363d] hover:text-[#58a6ff] hover:border-[#58a6ff] transition-all uppercase"
                >
                  Send Unicast Pulse
                </button>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  const handleGenerateInvite = async () => {
    if (!inviteRole || !inviteePeerId) return;
    try {
      const token = await window.vsmAPI.generateInvite(inviteType, inviteRole, inviteePeerId);
      setInviteToken(token);
    } catch (e: any) {
      alert(e?.message || 'Failed to generate invite');
    }
  };

  const handleJoinMesh = async () => {
    if (!joinToken || isJoining) return;
    setIsJoining(true);
    setJoinStatus('connecting');
    try {
      const res = await window.vsmAPI.joinMesh(joinToken);
      if (res.success) {
        setJoinStatus('success');
        const newTopo = await window.vsmAPI.getTopology();
        setTopology(newTopo);
        const ft = await window.vsmAPI.getFullTopology();
        setFullTopology(ft || {});
      } else {
        setJoinStatus('failed');
        alert(`Failed to join: ${res.error}`);
        setTimeout(() => setJoinStatus('idle'), 3000);
      }
    } catch (e: any) {
      setJoinStatus('failed');
      alert(e?.message || 'Connection failed');
      setTimeout(() => setJoinStatus('idle'), 3000);
    } finally {
      setIsJoining(false);
    }
  };

  const handleLeaveMesh = async () => {
    if (!confirm('Are you sure you want to leave the mesh? This will disconnect you from all peers.')) return;
    try {
      await window.vsmAPI.leaveMesh();
      const newTopo = await window.vsmAPI.getTopology();
      setTopology(newTopo);
      alert('Left the mesh.');
    } catch (e: any) {
      alert('Failed to leave mesh');
    }
  };

  const handleSetDisplayName = async () => {
    if (!displayName) return;
    await window.vsmAPI.setDisplayName(displayName);
    alert('Display Name Updated');
    const newTopo = await window.vsmAPI.getTopology();
    setTopology(newTopo);
  };

  return (
    <div className="flex-1 flex flex-col p-8 bg-[#0d1117] overflow-y-auto">
      <div className="max-w-3xl mx-auto w-full space-y-12">
        {/* Header */}
        <header className="space-y-2">
          <h1 className="text-2xl font-bold text-[#c9d1d9] tracking-tight">Network</h1>
          <p className="text-[#8b949e] text-sm font-mono">Peer-to-peer coordination</p>
        </header>

        {/* Local Node Identity & Topology */}
        <section className="space-y-4">
          <div className="border-b border-[#30363d] pb-2 flex justify-between items-end">
            <h2 className="text-xs uppercase tracking-widest text-[#8b949e]">Local Identity & Topology</h2>
          </div>
          
          {/* Display Name Setting */}
          <div className="flex gap-4 mb-4">
            <input 
              type="text"
              placeholder="Your Display Name"
              className="flex-1 bg-[#161b22] border border-[#30363d] text-xs text-[#c9d1d9] p-2 outline-none"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
            <button 
              onClick={handleSetDisplayName}
              className="bg-[#21262d] hover:bg-[#30363d] border border-[#30363d] px-4 text-xs font-bold tracking-widest text-[#c9d1d9] transition-all"
            >
              SAVE NAME
            </button>
          </div>

            <div className="grid grid-cols-2 gap-4">
             <div className="p-4 bg-[#161b22] border border-[#30363d] rounded-sm">
              <h3 className="text-[10px] uppercase text-[#8b949e] mb-1">Peer ID</h3>
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-mono text-[#58a6ff] truncate">{status?.peerId || 'INITIALIZING...'}</p>
                <button
                  onClick={async () => {
                    if (!status?.peerId) return;
                    try {
                      await navigator.clipboard.writeText(status.peerId);
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    } catch {
                      // ignore
                    }
                  }}
                  className="bg-[#21262d] hover:bg-[#30363d] border border-[#30363d] px-2 py-1 text-[10px] font-bold tracking-widest text-[#c9d1d9] transition-all shrink-0"
                  title="Copy Peer ID"
                >
                  {copied ? 'COPIED' : 'COPY'}
                </button>
              </div>
            </div>
             <div className="p-4 bg-[#161b22] border border-[#30363d] rounded-sm">
              <h3 className="text-[10px] uppercase text-[#8b949e] mb-1">Position</h3>
              <p className="text-xs font-mono text-[#3fb950]">Level {topology?.level || 1} - {topology?.role || 'Standalone'}</p>
            </div>
            <div className="p-4 bg-[#161b22] border border-[#30363d] rounded-sm">
              <h3 className="text-[10px] uppercase text-[#8b949e] mb-1">Parent</h3>
              <p className="text-xs font-mono text-[#c9d1d9] truncate">{topology?.parent ? 'PARENT' : 'NONE (ROOT)'}</p>
            </div>
             <div className="p-4 bg-[#161b22] border border-[#30363d] rounded-sm">
              <h3 className="text-[10px] uppercase text-[#8b949e] mb-1">Status</h3>
              <div className="flex items-center justify-between">
                <p className="text-xs font-mono text-[#3fb950]">CONNECTED</p>
                {isAlreadyInMesh ? (
                  <button 
                    onClick={handleLeaveMesh}
                    className="text-[10px] text-[#f85149] hover:underline uppercase font-bold"
                  >
                    LEAVE MESH
                  </button>
                ) : null}
              </div>
            </div>
            <div className="p-4 bg-[#161b22] border border-[#30363d] rounded-sm col-span-2">
              <h3 className="text-[10px] uppercase text-[#8b949e] mb-1">Tor Status</h3>
              <p className={`text-xs font-mono ${torColor}`}>{torState.toUpperCase()}</p>
              {status?.tor?.lastError && (
                <p className="text-[10px] text-[#f85149] mt-2 break-all">
                  {status.tor.lastError}
                </p>
              )}
            </div>
          </div>
        </section>

        {/* Invitation System */}
        <section className="space-y-4">
          <div className="border-b border-[#30363d] pb-2">
            <h2 className="text-xs uppercase tracking-widest text-[#8b949e]">Invite Peers</h2>
          </div>
          <div className="p-6 bg-[#161b22] border border-[#30363d] rounded-sm space-y-6">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <label className="text-[10px] uppercase text-[#8b949e]">Invite Type</label>
                <select 
                  className="w-full bg-[#0d1117] border border-[#30363d] text-xs text-[#c9d1d9] p-2 outline-none"
                  value={inviteType}
                  onChange={(e) => setInviteType(e.target.value as 'PEER' | 'MEMBER')}
                >
                  <option value="MEMBER">Member Invite</option>
                  <option value="PEER">Peer Invite</option>
                </select>
              </div>
              <div className="space-y-1">
                <label className="text-[10px] uppercase text-[#8b949e]">Assigned Role</label>
                <input 
                  type="text"
                  placeholder="e.g. Battery Specialist"
                  className="w-full bg-[#0d1117] border border-[#30363d] text-xs text-[#c9d1d9] p-2 outline-none"
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value)}
                />
              </div>
            </div>
            <div className="space-y-1">
              <label className="text-[10px] uppercase text-[#8b949e]">Invitee Peer ID</label>
              <input 
                type="text"
                placeholder="Paste invitee Peer ID"
                className="w-full bg-[#0d1117] border border-[#30363d] text-xs text-[#c9d1d9] p-2 outline-none"
                value={inviteePeerId}
                onChange={(e) => setInviteePeerId(e.target.value)}
              />
            </div>
            <button 
              onClick={handleGenerateInvite}
              className="w-full cyber-button py-2 text-xs font-bold tracking-widest text-[#58a6ff]"
            >
              GENERATE INVITE TOKEN
            </button>
            {inviteToken && (
              <div className="space-y-2">
                <div className="flex justify-between items-center">
                  <p className="text-[10px] text-[#3fb950]">Token generated! Share this base64 string with the new node:</p>
                  <button
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(inviteToken);
                        alert('Token copied to clipboard');
                      } catch {
                        // ignore
                      }
                    }}
                    className="bg-[#21262d] hover:bg-[#30363d] border border-[#30363d] px-2 py-1 text-[10px] font-bold tracking-widest text-[#c9d1d9] transition-all"
                  >
                    COPY TOKEN
                  </button>
                </div>
                <textarea 
                  readOnly 
                  className="w-full h-24 bg-[#0d1117] border border-[#30363d] text-[10px] font-mono text-[#8b949e] p-2 break-all"
                  value={inviteToken}
                />
              </div>
            )}
          </div>
        </section>

        {/* Joining System */}
        {!isAlreadyInMesh && (
          <section className="space-y-4">
            <div className="border-b border-[#30363d] pb-2">
              <h2 className="text-xs uppercase tracking-widest text-[#8b949e]">Join a Network</h2>
            </div>
            <div className="p-6 bg-[#161b22] border border-[#30363d] rounded-sm space-y-4">
              <div className="space-y-1">
                <label className="text-[10px] uppercase text-[#8b949e]">Paste Invite Token</label>
                <textarea 
                  placeholder="Paste the base64 token here..."
                  className="w-full h-24 bg-[#0d1117] border border-[#30363d] text-[10px] font-mono text-[#c9d1d9] p-2 outline-none"
                  value={joinToken}
                  onChange={(e) => setJoinToken(e.target.value)}
                />
              </div>
              <button 
                onClick={handleJoinMesh}
                disabled={isJoining}
                className={`w-full py-2 text-xs font-bold tracking-widest transition-all border ${
                  joinStatus === 'connecting' ? 'bg-[#30363d] text-[#8b949e] border-[#30363d] cursor-wait' :
                  joinStatus === 'success' ? 'bg-[#238636] text-white border-[#238636]' :
                  joinStatus === 'failed' ? 'bg-[#da3633] text-white border-[#da3633]' :
                  'bg-[#21262d] hover:bg-[#30363d] text-[#c9d1d9] border-[#30363d]'
                }`}
              >
                {joinStatus === 'connecting' ? 'ESTABLISHING HANDSHAKE...' :
                 joinStatus === 'success' ? 'CONNECTED SUCCESSFULLY' :
                 joinStatus === 'failed' ? 'CONNECTION FAILED' :
                 'ESTABLISH HIERARCHICAL HANDSHAKE'}
              </button>
            </div>
          </section>
        )}

        {/* Connected Peers */}
        <section className="space-y-4">
          <div className="border-b border-[#30363d] pb-2">
            <h2 className="text-xs uppercase tracking-widest text-[#8b949e]">Mesh Visualization</h2>
          </div>
          {renderMeshNodes()}
        </section>
      </div>
    </div>
  );
};

export default NetworkView;
