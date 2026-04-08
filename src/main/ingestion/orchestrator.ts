import chokidar from 'chokidar';
import path from 'path';
import fs from 'fs/promises';
import { DocumentParser } from './parser.js';
import { LLMService } from '../services/llm.js';
import { TokenService } from '../services/token.js';
import { RestructuringService } from '../services/restructuring.js';

export interface IngestionProgress {
  status: 'STARTING' | 'INGESTING' | 'COMPLETED' | 'ERROR' | 'RESTRUCTURING';
  file?: string;
  count?: number;
  total?: number;
  message?: string;
  tokens?: number;
}

export interface FileSummary {
  filePath: string;
  fileName: string;
  summary: string;
  lastUpdated: number;
  tokens: number;
}

export class IngestionOrchestrator {
  private watcher: chokidar.FSWatcher | null = null;
  private parser: DocumentParser;
  private llm: LLMService;
  private restructurer: RestructuringService;
  private onProgress?: (p: IngestionProgress) => void;
  private watchDir: string | null = null;
  private summaries: Map<string, FileSummary> = new Map();
  private isRestructuring = false;

  constructor() {
    this.parser = new DocumentParser();
    this.llm = new LLMService();
    this.restructurer = new RestructuringService();
  }

  private processingQueue: Promise<void> = Promise.resolve();

  async start(watchDir: string, onProgress?: (p: IngestionProgress) => void): Promise<void> {
    this.watchDir = watchDir;
    this.onProgress = onProgress;
    console.log(`Starting Ingestion Orchestrator on ${watchDir}...`);
    this.onProgress?.({ status: 'STARTING', message: `Watching ${watchDir}` });

    // Load existing summaries to populate memory immediately
    await this.loadExistingSummaries();

    this.watcher = chokidar.watch(watchDir, {
      ignored: (testPath, stats) => {
        if (stats?.isDirectory()) {
          const basename = path.basename(testPath);
          return basename.startsWith('.') || basename === 'node_modules';
        }
        const basename = path.basename(testPath);
        if (basename.startsWith('.')) return true;
        if (basename === 'VSM_SUMMARY.md') return true;
        const ext = path.extname(testPath).toLowerCase();
        const allowed = ['.md', '.markdown', '.pdf', '.txt'];
        if (ext && !allowed.includes(ext)) return true;
        return false;
      },
      persistent: true,
      ignoreInitial: false,
      alwaysStat: true
    });

    const queueProcess = (filePath: string) => {
      this.processingQueue = this.processingQueue.then(() => this.processFile(filePath));
    };

    this.watcher.on('add', (filePath) => queueProcess(filePath));
    this.watcher.on('change', (filePath) => queueProcess(filePath));
    this.watcher.on('unlink', (filePath) => {
      this.summaries.delete(filePath);
      this.saveProjectSummary();
    });
  }

  private async loadExistingSummaries() {
    if (!this.watchDir) return;
    const summaryPath = path.join(this.watchDir, 'VSM_SUMMARY.md');
    try {
      const content = await fs.readFile(summaryPath, 'utf-8');
      
      // Basic parsing of our "Secretary File" format
      // Group: ### [filename](./path) \n summary \n Tokens: X
      const blocks = content.split('---');
      for (const block of blocks) {
        const fileMatch = block.match(/### \[([^\]]+)\]\(\.\/([^\)]+)\)/);
        const tokenMatch = block.match(/\*\*Tokens:\*\* ([\d,]+)/);
        
        if (fileMatch) {
          const fileName = fileMatch[1];
          const relPath = fileMatch[2];
          const tokens = tokenMatch ? parseInt(tokenMatch[1].replace(/,/g, ''), 10) : 0;
          
          // Extract everything between the header and the token footer as the summary
          const summaryPart = block.split('\n').filter(line => {
             const trim = line.trim();
             return trim && !trim.startsWith('###') && !trim.startsWith('**Tokens:**') && !trim.startsWith('---');
          }).join(' ');

          // Get actual mtime to ensure we don't re-process
          let lastUpdated = Date.now();
          const fullPath = path.join(this.watchDir, relPath);
          try {
             const stats = await fs.stat(fullPath);
             lastUpdated = stats.mtimeMs;
          } catch(e) {}

          this.summaries.set(fullPath, {
            fileName,
            filePath: relPath,
            summary: summaryPart.trim(),
            tokens: tokens,
            lastUpdated: lastUpdated
          });
        }
      }
      console.log(`[ORCHESTRATOR] Loaded ${this.summaries.size} existing summaries from VSM_SUMMARY.md`);
    } catch (e) {
      console.log("[ORCHESTRATOR] No existing summary file to load.");
    }
  }

  private async processFile(filePath: string): Promise<void> {
    if (this.isRestructuring) return;
    
    const fileName = path.basename(filePath);
    try {
      const stats = await fs.stat(filePath);
      const lastModified = stats.mtimeMs;
      const existing = this.summaries.get(filePath);

      // CRITICAL: Skip if we already have this file and it hasn't been modified
      if (existing && existing.lastUpdated >= lastModified) {
        console.log(`[ORCHESTRATOR] Skipping ${fileName} - already up to date.`);
        return;
      }

      this.onProgress?.({ 
        status: 'INGESTING', 
        file: fileName, 
        message: `Analyzing ${fileName}`,
        tokens: this.getTotalTokens()
      });
      
      const parsed = await this.parser.parse(filePath);
      const tokenCount = TokenService.estimateTokens(parsed.content);
      
      // Limit content for summary generation
      const contentPrefix = parsed.content.substring(0, 4000);
      
      const summaryResult = await this.llm.generateAnswer(
        `Provide a concise 2-3 sentence summary of the following document. Focus on its purpose and key information. Document: ${fileName}`,
        contentPrefix
      );

      this.summaries.set(filePath, {
        filePath: path.relative(this.watchDir!, filePath),
        fileName,
        summary: summaryResult,
        lastUpdated: Date.now(),
        tokens: tokenCount
      });

      await this.saveProjectSummary();
      
      const totalTokens = this.getTotalTokens();
      this.onProgress?.({ 
        status: 'COMPLETED', 
        file: fileName, 
        message: `Summarized ${fileName}`,
        tokens: totalTokens
      });

      // Check for 100k token limit
      if (totalTokens > 100000 && !this.isRestructuring) {
        await this.triggerRestructure();
      }

    } catch (e) {
      console.error(`[ORCHESTRATOR] Error processing ${filePath}:`, e);
      this.onProgress?.({ status: 'ERROR', file: fileName, message: `Error: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  public getTotalTokens(): number {
    let total = 0;
    for (const s of this.summaries.values()) {
      total += s.tokens;
    }
    return total;
  }

  private async triggerRestructure() {
    this.isRestructuring = true;
    this.onProgress?.({ 
      status: 'RESTRUCTURING', 
      message: 'Token limit exceeded (100k). Auto-organizing folders...' 
    });

    try {
      const result = await this.restructurer.autoRestructure(this.watchDir!, Array.from(this.summaries.values()));
      if (result.success) {
        // Clear local summaries to force a re-index of the new structure
        this.summaries.clear();
        this.onProgress?.({ status: 'COMPLETED', message: 'Restructuring complete. Re-indexing...' });
      } else {
        throw new Error(result.message);
      }
    } catch (e: any) {
      console.error('[ORCHESTRATOR] Restructuring failed:', e);
      this.onProgress?.({ status: 'ERROR', message: `Restructuring failed: ${e.message}` });
    } finally {
      this.isRestructuring = false;
    }
  }

  private async saveProjectSummary() {
    if (!this.watchDir) return;
    const summaryPath = path.join(this.watchDir, 'VSM_SUMMARY.md');
    
    let md = `# VSM PROJECT SUMMARY (Secretary File)\n\n`;
    md += `*Generated on: ${new Date().toLocaleString()}*\n\n`;
    md += `This index allows OpenClaw to navigate the project hierarchy. Documents are summarized to maintain a lean context window.\n\n`;
    md += `---\n\n`;
    
    for (const [_, s] of this.summaries) {
      md += `### [${s.fileName}](./${s.filePath})\n`;
      md += `${s.summary.replace(/\n/g, ' ')}\n\n`;
      md += `**Tokens:** ${s.tokens.toLocaleString()}\n\n`;
      md += `---\n\n`;
    }

    md += `\n**Total Estimated Project Weight:** ${this.getTotalTokens().toLocaleString()} tokens\n`;

    await fs.writeFile(summaryPath, md);
  }

  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }
}

