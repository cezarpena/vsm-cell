import { P2PService, VSM_Message } from './p2p.js';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';

export interface AgentResponse {
  content: string;
  status: 'PROPOSE' | 'VETO' | 'SUCCESS';
  rationale?: string;
}

let agentsListInFlight: Promise<Array<{ id: string; name?: string }>> | null = null;

export class AgenticController {
  private p2p?: P2PService;
  private openclawCommand: string;
  private openclawBaseArgs: string[];
  private agentId: string | null = null;
  private watchDir: string = '';

  constructor(p2p?: P2PService, options?: { openclawBin?: string }) {
    this.p2p = p2p;
    this.watchDir = process.env.WATCH_DIR || path.join(process.cwd(), 'watch');
    const resolved = resolveOpenclawCommand(options?.openclawBin);
    this.openclawCommand = resolved.command;
    this.openclawBaseArgs = resolved.baseArgs;

    if (this.p2p) {
      this.p2p.onMessage((topic, message) => this.handleRemotePulse(topic, message));
    }
  }

  setWatchDir(dir: string) {
    this.watchDir = dir;
  }

  /**
   * Handle an incoming pulse from another cell.
   */
  private async handleRemotePulse(topic: string, message: VSM_Message) {
    if (message.type === 'QUERY' && message.scope === 'REMOTE') {
      console.log(`[Agent] Handling remote REMOTE query from ${message.origin_cell}`);
      const watchDir = this.watchDir;
      
      const response = await this.process(message.payload.text_content, watchDir);
      
      if (this.p2p) {
        await this.p2p.remote(message.origin_cell, 'REPORT', {
          text_content: response.content,
          data: {
            original_request_id: message.request_id,
            status: response.status
          }
        });
      }
    }
  }

  /**
   * Main entry point for agent turns.
   * Follows the "Sense -> Evaluate -> Reason -> Respond" loop.
   */
  async process(query: string, watchDir: string): Promise<AgentResponse> {
    console.log(`Agent processing query: ${query}`);

    try {
      // VSM Context Injection:
      // We prepend a "Recusive Pulse" hint to let the agent know where it is and to use the VSM_SUMMARY.md.
      const contextHint = `(SYSTEM: Workspace is at ${watchDir}. Refer to VSM_SUMMARY.md for project context. Answer concisely.) `;
      const output = await this.runOpenClaw(contextHint + query, watchDir);
      return {
        content: output,
        status: 'SUCCESS'
      };
    } catch (e) {
      console.error('OpenClaw execution failed:', e);
      return {
        content: `OpenClaw failed: ${e instanceof Error ? e.message : String(e)}`,
        status: 'VETO'
      };
    }
  }

  async listAgents(): Promise<Array<{ id: string; name?: string }>> {
    return listOpenclawAgents();
  }

  getAgentId(): string | null {
    return this.agentId;
  }

  setAgentId(agentId: string | null) {
    this.agentId = agentId && agentId.trim() ? agentId.trim() : null;
  }

  private async runOpenClaw(
    query: string,
    watchDir: string,
  ): Promise<string> {
    const sessionId = this.buildSessionId();
    // We remove the invalid --workspace-dir flag and ensure the child process is spawned 
    // with its working directory set to the watchDir.
    const args = [
      ...this.openclawBaseArgs, 
      'agent', 
      '--message', query, 
      '--local', 
      '--json', 
      '--session-id', sessionId
    ];
    
    if (this.agentId) {
      args.push('--agent', this.agentId);
    }

    // If it's the first message of the session, we give it a 'Recursive Pulse' hint
    // To keep it simple, we'll just add it to the environment or a separate flag if supported,
    // but for now, we'll ensure the workspace-dir is the primary fix.
    
    console.log(`[Agent] Executing OpenClaw: ${this.openclawCommand} ${args.join(' ')}`);

    return new Promise((resolve, reject) => {
      const env = { 
        ...process.env, 
        TERM: process.env.TERM || 'xterm-256color',
        ELECTRON_RUN_AS_NODE: '1'
      };

      const child = spawn(this.openclawCommand, args, {
        cwd: watchDir,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => {
        stdout += d.toString('utf-8');
      });
      child.stderr.on('data', (d) => {
        stderr += d.toString('utf-8');
      });
      child.on('error', (err) => {
        console.error('[Agent] OpenClaw spawn error:', err);
        reject(err);
      });
      child.on('close', (code) => {
        if (code !== 0) {
          console.error(`[Agent] OpenClaw exited with code ${code}. Stderr: ${stderr}`);
          return reject(new Error(stderr.trim() || stdout.trim() || `openclaw exited with code ${code}`));
        }
        const parsed = parseOpenClawOutput(stdout);
        resolve(parsed || stderr.trim() || 'OpenClaw returned no output.');
      });
    });
  }

  private buildSessionId(): string {
    return `vsmcell-${this.agentId ?? 'default'}`;
  }

  // No custom OpenClaw config; rely on user's existing setup.
}

function resolveOpenclawCommand(overrideBin?: string): { command: string; baseArgs: string[] } {
  const envOverride = process.env.OPENCLAW_BIN;
  const bin = overrideBin || envOverride;
  if (bin) {
    const lower = bin.toLowerCase();
    if (lower.endsWith('.mjs') || lower.endsWith('.js')) {
      return { command: process.execPath, baseArgs: [bin] };
    }
    return { command: bin, baseArgs: [] };
  }

  const cliPath = path.join(process.cwd(), 'node_modules', 'openclaw', 'openclaw.mjs');
  if (fs.existsSync(cliPath)) {
    return { command: process.execPath, baseArgs: [cliPath] };
  }

  const binName = process.platform === 'win32' ? 'openclaw.cmd' : 'openclaw';
  return { command: binName, baseArgs: [] };
}

export function listOpenclawAgents(overrideBin?: string): Promise<Array<{ id: string; name?: string }>> {
  if (agentsListInFlight) {
    return agentsListInFlight;
  }

  const { command, baseArgs } = resolveOpenclawCommand(overrideBin);
  const args = [...baseArgs, 'agents', 'list', '--json'];
  console.log(`[Agent] Fetching agents list: ${command} ${args.join(' ')}`);

  agentsListInFlight = new Promise((resolve, reject) => {
    const child = spawn(command, args, { 
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } 
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString('utf-8');
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString('utf-8');
    });
    child.on('error', (err) => {
      console.error('[Agent] Agent list spawn error:', err);
      reject(err);
    });
    child.on('close', (code) => {
      if (code !== 0) {
        console.error(`[Agent] Agent list exited with code ${code}. Stderr: ${stderr}`);
        return reject(new Error(stderr.trim() || stdout.trim() || `openclaw exited with code ${code}`));
      }
      console.log(`[Agent] Agents list stdout: ${stdout}`);
      const parsed = parseOpenClawAgents(stdout);
      if (!parsed.length && stderr.trim()) {
        return reject(new Error(stderr.trim()));
      }
      resolve(parsed);
    });
  }).finally(() => {
    agentsListInFlight = null;
  });

  return agentsListInFlight;
}

function parseOpenClawOutput(raw: string): string {
  const text = raw.trim();
  if (!text) return '';
  const jsonSlice = extractJsonSlice(text);
  if (!jsonSlice) return text;
  try {
    const json = JSON.parse(jsonSlice);
    const content = extractContent(json);
    return content || JSON.stringify(json, null, 2);
  } catch {
    return text;
  }
}

function parseOpenClawAgents(raw: string): Array<{ id: string; name?: string }> {
  const text = raw.trim();
  if (!text) return [];

  const jsonSlice = extractJsonSlice(text);
  if (!jsonSlice) return [];
  try {
    const parsed = JSON.parse(jsonSlice);
    return normalizeAgentsPayload(parsed);
  } catch {
    return [];
  }
}

function normalizeAgentsPayload(json: any): Array<{ id: string; name?: string }> {
  if (Array.isArray(json)) {
    return json
      .map((item) => normalizeAgent(item))
      .filter((item): item is { id: string; name?: string } => Boolean(item));
  }
  if (Array.isArray(json?.agents)) {
    return json.agents
      .map((item: any) => normalizeAgent(item))
      .filter((item: any) => Boolean(item));
  }
  return [];
}

function extractJsonSlice(text: string): string | null {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== '{' && ch !== '[') continue;
    const candidate = sliceJsonFrom(text, i);
    if (!candidate) continue;
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

function sliceJsonFrom(text: string, start: number): string | null {
  const stack: string[] = [];
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\\\') {
      if (inString) escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{' || ch === '[') {
      stack.push(ch);
    } else if (ch === '}' || ch === ']') {
      if (!stack.length) return null;
      const open = stack.pop();
      if ((open === '{' && ch !== '}') || (open === '[' && ch !== ']')) {
        return null;
      }
      if (!stack.length) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

function normalizeAgent(item: any): { id: string; name?: string } | null {
  if (!item) return null;
  if (typeof item === 'string') return { id: item };
  if (typeof item === 'object') {
    const id = item.id || item.agentId || item.name;
    if (!id || typeof id !== 'string') return null;
    const name = typeof item.name === 'string' ? item.name : undefined;
    return { id, name };
  }
  return null;
}

function extractContent(payload: any): string {
  if (!payload || typeof payload !== 'object') return '';
  
  // Handle 'payloads' array from latest OpenClaw
  if (Array.isArray(payload.payloads)) {
    return payload.payloads
      .map((p: any) => p?.text || '')
      .filter(Boolean)
      .join('\n');
  }

  if (typeof payload.content === 'string') return payload.content;
  if (typeof payload.message === 'string') return payload.message;
  if (payload.message?.content) {
    if (typeof payload.message.content === 'string') return payload.message.content;
    if (Array.isArray(payload.message.content)) {
      return payload.message.content.map((p: any) => p?.text || '').filter(Boolean).join('\n');
    }
  }
  if (payload.reply?.content) {
    if (typeof payload.reply.content === 'string') return payload.reply.content;
    if (Array.isArray(payload.reply.content)) {
      return payload.reply.content.map((p: any) => p?.text || '').filter(Boolean).join('\n');
    }
  }
  return '';
}
