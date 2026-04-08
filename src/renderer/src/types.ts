export type PulseScope = 'LOCAL' | 'REMOTE';

export interface Message {
  role: 'user' | 'agent' | 'system'
  content: string
  citations?: string[]
  scope?: PulseScope
  target?: string
}

export interface HKGStatus {
  status: string
  peerId: string
  project: string
  peers?: string[]
  watchDir?: string
  totalTokens?: number;
  tor?: {
    state: 'starting' | 'running' | 'restarting' | 'stopped' | 'error';
    lastError?: string;
  };
}

export interface IngestionProgress {
  status: 'STARTING' | 'INGESTING' | 'COMPLETED' | 'ERROR' | 'RESTRUCTURING';
  file?: string;
  count?: number;
  total?: number;
  message?: string;
  tokens?: number;
}

export interface FrictionAlert {
  id: string;
  type: 'S2' | 'S3';
  message: string;
  timestamp: number;
}
