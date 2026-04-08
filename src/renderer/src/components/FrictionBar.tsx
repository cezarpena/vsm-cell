import React from 'react';
import { FrictionAlert } from '../types';

interface FrictionBarProps {
  alerts: FrictionAlert[];
  onDismiss: (id: string) => void;
}

const FrictionBar: React.FC<FrictionBarProps> = ({ alerts, onDismiss }) => {
  if (alerts.length === 0) return null;

  const currentAlert = alerts[0];

  return (
    <div className={`fixed bottom-0 left-16 right-0 p-3 flex items-center justify-between border-t border-[#30363d] transition-all duration-300 z-50 ${
      currentAlert.type === 'S2' ? 'bg-[#161b22] border-l-4 border-l-[#f85149]' : 'bg-[#161b22] border-l-4 border-l-[#e3b341]'
    }`}>
      <div className="flex items-center gap-4">
        <span className={`text-[10px] font-bold px-1 py-0.5 rounded-sm ${
          currentAlert.type === 'S2' ? 'bg-[#f85149] text-white' : 'bg-[#e3b341] text-black'
        }`}>
          {currentAlert.type === 'S2' ? 'ALERT' : 'NOTICE'}
        </span>
        <p className="text-xs text-[#c9d1d9] font-mono">{currentAlert.message}</p>
      </div>
      <div className="flex items-center gap-4">
        {alerts.length > 1 && (
          <span className="text-[10px] text-[#8b949e]">+{alerts.length - 1} more</span>
        )}
        <button 
          onClick={() => onDismiss(currentAlert.id)}
          className="text-[#8b949e] hover:text-[#c9d1d9] transition-all p-1"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        </button>
      </div>
    </div>
  );
};

export default FrictionBar;
