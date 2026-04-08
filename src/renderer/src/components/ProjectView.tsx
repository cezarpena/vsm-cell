import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { HKGStatus, IngestionProgress } from '../types';

interface ProjectViewProps {
  status: HKGStatus | null;
  onSelectDir: () => void;
  ingestionProgress: IngestionProgress | null;
  summaryContent: string;
}

const ProjectView: React.FC<ProjectViewProps> = ({ status, onSelectDir, ingestionProgress, summaryContent }) => {
  const tokenLimit = 100000;
  // Use status.totalTokens as a fallback if ingestion is not active
  const currentTokens = ingestionProgress?.tokens ?? status?.totalTokens ?? 0;
  const tokenPercentage = Math.min((currentTokens / tokenLimit) * 100, 100);

  return (
    <div className="flex-1 h-full min-h-0 flex flex-col p-8 bg-[#0d1117] overflow-y-auto">
      <div className="max-w-4xl mx-auto w-full space-y-12">
        {/* Header */}
        <header className="flex justify-between items-start shrink-0">
          <div className="space-y-2">
            <h1 className="text-2xl font-bold text-[#c9d1d9] tracking-tight">Project Context</h1>
            <p className="text-[#8b949e] text-sm font-mono">Local workspace context</p>
          </div>
          <div className="text-right space-y-2">
            <div className="flex items-center gap-2 justify-end">
               <span className="text-[10px] text-[#8b949e] font-mono">TOKEN CAPACITY</span>
               <span className={`text-xs font-mono ${currentTokens > tokenLimit ? 'text-[#f85149] font-bold' : 'text-[#c9d1d9]'}`}>
                {currentTokens.toLocaleString()} / {tokenLimit.toLocaleString()}
               </span>
            </div>
            <div className="w-48 bg-[#30363d] h-1.5 ml-auto rounded-full overflow-hidden">
               <div 
                className={`h-full transition-all duration-500 ${currentTokens > tokenLimit ? 'bg-[#f85149]' : 'bg-[#58a6ff]'}`}
                style={{ width: `${tokenPercentage}%` }}
               />
            </div>
          </div>
        </header>

        {/* Directory Selection */}
        <section className="space-y-4 shrink-0">
          <div className="flex items-center justify-between border-b border-[#30363d] pb-2">
            <h2 className="text-xs uppercase tracking-widest text-[#8b949e]">Shared Folder</h2>
            <button 
              onClick={onSelectDir}
              className="text-xs text-[#58a6ff] hover:underline transition-all font-mono"
            >
              CHANGE DIRECTORY
            </button>
          </div>
          <div className="p-4 bg-[#161b22] border border-[#30363d] rounded-sm">
            <p className="text-sm font-mono text-[#c9d1d9] truncate">
              {status?.watchDir || 'NOT SET'}
            </p>
          </div>
        </section>

        {/* Dynamic Ingestion / Restructuring State */}
        {ingestionProgress && (
          <section className={`p-4 border border-[#30363d] rounded-sm flex items-center justify-between bg-[#161b22] shrink-0 ${
            ingestionProgress.status === 'RESTRUCTURING' ? 'border-l-4 border-l-[#f85149] animate-pulse' : 'border-l-4 border-l-[#58a6ff]'
          }`}>
            <div className="space-y-1">
              <h3 className={`text-xs font-bold uppercase tracking-widest ${
                ingestionProgress.status === 'RESTRUCTURING' ? 'text-[#f85149]' : 'text-[#58a6ff]'
              }`}>
                {ingestionProgress.status === 'RESTRUCTURING' ? 'Auto-Restructuring' : 'Ingesting Digital DNA'}
              </h3>
              <p className="text-[10px] text-[#8b949e] font-mono">
                {ingestionProgress.message}
              </p>
            </div>
            {ingestionProgress.file && (
              <span className="text-[10px] text-[#8b949e] font-mono italic truncate max-w-[200px]">
                {ingestionProgress.file}
              </span>
            )}
          </section>
        )}

        {/* Summary File: VSM_SUMMARY.md */}
        <section className="space-y-4">
          <div className="border-b border-[#30363d] pb-2 flex justify-between items-center">
            <h2 className="text-xs uppercase tracking-widest text-[#8b949e]">Summary File (VSM_SUMMARY.md)</h2>
            {summaryContent && (
              <span className="text-[10px] text-[#3fb950] font-mono">● SYNCHRONIZED</span>
            )}
          </div>
          <div className="p-8 bg-[#161b22] border border-[#30363d] rounded-sm min-h-[300px]">
            {summaryContent ? (
              <div className="prose prose-invert prose-sm max-w-none prose-h1:text-lg prose-h2:text-base prose-table:text-[11px]">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {summaryContent}
                </ReactMarkdown>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center h-full py-12 space-y-4 text-center">
                <p className="text-[#8b949e] italic text-sm max-w-sm">
                  {status?.watchDir 
                    ? "Generating high-level project index. OpenClaw is scanning files to build the Secretary File..." 
                    : "Connect a project folder to begin scanning DNA and generating the hierarchical index."}
                </p>
              </div>
            )}
          </div>
        </section>

        {/* Hierarchical Navigation Hint */}
        <section className="p-4 bg-[#0d1117] border border-dashed border-[#30363d] rounded-sm shrink-0">
           <p className="text-[10px] text-[#8b949e] leading-relaxed">
            <span className="text-[#58a6ff] font-bold">TIP:</span> When a folder exceeds 100,000 tokens, OpenClaw will automatically partition files into sub-directories to maintain efficiency. Use the Summary File above to navigate the resulting hierarchy.
           </p>
        </section>
      </div>
    </div>
  );
};

export default ProjectView;
