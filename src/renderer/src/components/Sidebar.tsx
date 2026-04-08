import React from 'react';

interface SidebarProps {
  currentView: 'project' | 'chat' | 'network';
  setView: (view: 'project' | 'chat' | 'network') => void;
  status: 'online' | 'offline';
}

const Sidebar: React.FC<SidebarProps> = ({ currentView, setView, status }) => {
  return (
    <div className="w-16 h-full flex flex-col items-center py-4 bg-[#0d1117] border-r border-[#30363d] gap-8">
      <div className={`w-3 h-3 rounded-full mb-4 ${status === 'online' ? 'bg-[#3fb950]' : 'bg-[#f85149]'}`} />
      
      <button 
        onClick={() => setView('project')}
        className={`p-3 rounded-lg transition-all ${currentView === 'project' ? 'bg-[#21262d] text-[#58a6ff]' : 'text-[#8b949e] hover:text-[#c9d1d9]'}`}
        title="Project"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
      </button>

      <button 
        onClick={() => setView('chat')}
        className={`p-3 rounded-lg transition-all ${currentView === 'chat' ? 'bg-[#21262d] text-[#58a6ff]' : 'text-[#8b949e] hover:text-[#c9d1d9]'}`}
        title="Chat"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
      </button>

      <button 
        onClick={() => setView('network')}
        className={`p-3 rounded-lg transition-all ${currentView === 'network' ? 'bg-[#21262d] text-[#58a6ff]' : 'text-[#8b949e] hover:text-[#c9d1d9]'}`}
        title="Network"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M12 9V2l4 4-4 4"></path><path d="M5 13l-3-3 3-3"></path><path d="m2 10 7 7-7 7"></path><path d="m22 10-7 7 7 7"></path></svg>
      </button>

    </div>
  );
};

export default Sidebar;
