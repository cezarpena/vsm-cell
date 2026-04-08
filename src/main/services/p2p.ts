import { createLibp2p, Libp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { mdns } from '@libp2p/mdns';
import { kadDHT } from '@libp2p/kad-dht';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { identify } from '@libp2p/identify';
import { ping } from '@libp2p/ping';
import { createEd25519PeerId, createFromJSON } from '@libp2p/peer-id-factory';
import { peerIdFromString } from '@libp2p/peer-id';
import { privateKeyFromProtobuf, publicKeyFromProtobuf, publicKeyToProtobuf } from '@libp2p/crypto/keys';
import { multiaddr } from '@multiformats/multiaddr';
import { lpStream } from 'it-length-prefixed-stream';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { torTransport } from './tor-transport.js';

type TorNetConfig = {
  enabled: boolean;
  socksHost: string;
  socksPort: number;
  onionHost: string; // full host (xxx.onion)
  onionPort: number;
  localPort: number;
};

export interface VSM_Message {
  origin_cell: string;       // PeerId
  target_cell: string | 'all'; // PeerId or broadcast scope
  scope: 'REMOTE';
  type: 'QUERY' | 'REPORT' | 'DIRECTIVE' | 'ALGEDONIC' | 'S2_UPDATE';
  payload: {
    entity_id?: string;
    vector_hash?: string;
    text_content: string;
    data?: any;
  };
  s5_context: string;
  timestamp: number;
  request_id?: string;       // For RPC-style correlation
}

export interface InviteToken {
  invite_id: string;
  inviter_id: string;
  inviter_pubkey: string; // base64 protobuf public key
  inviter_multiaddrs: string[];
  invitee_id: string;
  assigned_level: number;
  assigned_role: string;
  invite_type: 'PEER' | 'MEMBER';
  project_hash: string;
  expiry: number;
  signature?: string;
}

export class P2PService {
  private node?: Libp2p<any>;
  private identityPath: string;
  private identityEncrypted: boolean;
  private tor?: TorNetConfig;
  private projectHash = 'vsm_default_project';
  private messageHandlers: ((topic: string, message: VSM_Message) => void)[] = [];
  private authorizedPeers: Set<string> = new Set();
  private meshMultiaddrs: Map<string, string[]> = new Map();
  private meshStatePath: string;
  private topology: any = { level: 3, role: 'Root Admin', displayName: 'Anonymous', parent: null, children: [], peers: [] };
  private fullTopology: Map<string, any> = new Map();
  private signingKey?: any;
  private profilePath: string;
  private peerId?: any;

  constructor(projectHash?: string, identityPath?: string, identityEncrypted: boolean = false, tor?: TorNetConfig) {
    if (projectHash) {
      this.projectHash = projectHash;
    } else {
      this.projectHash = Buffer.from('vsm_default_project').toString('hex');
    }
    this.identityPath = identityPath || path.join(process.cwd(), 'vsm_peer_id.json');
    this.identityEncrypted = identityEncrypted;
    this.tor = tor;
    const baseName = path.basename(this.identityPath, '.json');
    this.profilePath = path.join(path.dirname(this.identityPath), `${baseName}_profile.json`);
    this.meshStatePath = path.join(path.dirname(this.identityPath), `${baseName}_mesh_state.json`);
  }

  async setDisplayName(name: string) {
    this.topology.displayName = name;
    await this.saveProfile();
  }

  onMessage(handler: (topic: string, message: VSM_Message) => void) {
    this.messageHandlers.push(handler);
  }

  async start(): Promise<void> {
    if (this.node) {
      console.warn('P2PService.start called more than once; ignoring.');
      return;
    }
    let peerId;
    const identityPath = this.identityPath;
    await this.migrateEncryptedIdentityIfNeeded();
    try {
      const idData = await this.readIdentityFile();
      const jsonId = JSON.parse(idData);
      peerId = await createFromJSON(jsonId);
      console.log(`Loaded PeerId ${peerId.toString()} from ${identityPath}`);
    } catch (e: any) {
      console.warn(`Failed to load PeerId from ${identityPath}: ${e?.message || e}. Generating new one.`);
      peerId = await createEd25519PeerId();
      const jsonId = {
        id: peerId.toString(),
        privKey: Buffer.from(peerId.privateKey!).toString('base64'),
        pubKey: Buffer.from(peerId.publicKey!).toString('base64')
      };
      await this.writeIdentityFile(JSON.stringify(jsonId, null, 2));
      console.log(`Generated and saved new PeerId ${peerId.toString()} to ${identityPath}`);
    }
    this.peerId = peerId;

    await this.loadProfile();
    await this.loadMeshState();

    if (!peerId.privateKey) throw new Error('PeerId missing private key');
    const libp2pPrivateKey = privateKeyFromProtobuf(peerId.privateKey);
    this.signingKey = libp2pPrivateKey;

    const transports: any[] = [tcp()];
    if (this.tor?.enabled) {
      transports.push(torTransport({
        socksHost: this.tor.socksHost,
        socksPort: this.tor.socksPort
      }));
    }

    const listenAddrs = this.tor?.enabled
      ? [`/ip4/127.0.0.1/tcp/${this.tor.localPort}`]
      : ['/ip4/0.0.0.0/tcp/0'];
    
    const announceAddrs = this.tor?.enabled
      ? [`/onion3/${this.tor.onionHost.split('.')[0]}:${this.tor.onionPort}`]
      : [];

    console.log(`Starting libp2p with derived PeerId: ${peerId.toString()}`);
    this.node = await createLibp2p({
      privateKey: libp2pPrivateKey,
      addresses: { 
        listen: listenAddrs,
        announce: announceAddrs
      },
      connectionManager: {
        dialTimeout: 60000
      },
      transports,
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      peerDiscovery: [mdns({ interval: 1000 })],
      services: {
        identify: identify(),
        ping: ping(),
        dht: kadDHT({ protocol: `/vsm/${this.projectHash}/kad/1.0.0` }),
        pubsub: gossipsub({ 
          allowPublishToZeroTopicPeers: true,
          emitSelf: false
        })
      }
    });

    await this.node.handle('/vsm/onboard/1.0.0', async (stream: any, connection: any) => {
      const remotePeerId = connection.remotePeer.toString();
      console.log(`[ONBOARD] Incoming stream from ${remotePeerId}`);
      
      const duplex = {
        source: stream,
        sink: async (source: any) => {
          for await (const chunk of source) {
            const data = chunk instanceof Uint8Array ? chunk : chunk.subarray();
            console.log(`[ONBOARD] Sending ${data.byteLength} bytes to ${remotePeerId}`);
            (stream as any).send(data);
          }
        }
      };
      const lp = lpStream(duplex as any);
      try {
        const data = await lp.read();
        if (!data) {
          console.warn(`[ONBOARD] No data received from ${remotePeerId}`);
          stream.close();
          return;
        }

        const decoded = new TextDecoder().decode(data.subarray());
        console.log(`[ONBOARD] Received payload from ${remotePeerId}: ${decoded.substring(0, 100)}...`);
        const { invite, topology: remoteTopology } = JSON.parse(decoded);
        let authorized = this.authorizedPeers.has(remotePeerId);
        
        if (invite) {
          console.log(`[ONBOARD] Verifying invite for ${remotePeerId}...`);
          const isValid = await this.verifyInvite(invite);
          if (isValid && invite.invitee_id === remotePeerId) {
            console.log(`[HANDSHAKE] Valid invite accepted from ${remotePeerId}`);
            authorized = true;
            
            remoteTopology.level = invite.assigned_level;
            remoteTopology.role = invite.assigned_role;

            if (invite.invite_type === 'MEMBER') {
               remoteTopology.parent = this.getPeerId();
               if (!this.topology.children.includes(remotePeerId)) {
                 this.topology.children.push(remotePeerId);
               }
            } else if (invite.invite_type === 'PEER') {
               if (!this.topology.peers.includes(remotePeerId)) {
                 this.topology.peers.push(remotePeerId);
               }
            }
          } else {
            console.warn(`[ONBOARD] Invite verification failed for ${remotePeerId}. Valid: ${isValid}, Target: ${invite.invitee_id}`);
          }
        }

        if (!authorized) {
          console.warn(`[SECURITY] Unauthorized connection attempt from ${remotePeerId}. Dropping silently.`);
          stream.close();
          await connection.close();
          return;
        }

        console.log(`[HANDSHAKE] Authenticated node ${remotePeerId} joined.`);
        this.fullTopology.set(remotePeerId, remoteTopology);
        this.authorizedPeers.add(remotePeerId);
        await this.saveMeshState();
        
        const responseData = new TextEncoder().encode(JSON.stringify({ status: 'SUCCESS', topology: this.topology }));
        console.log(`[ONBOARD] Sending SUCCESS response to ${remotePeerId}`);
        await lp.write(responseData);
        console.log(`[ONBOARD] Handshake complete for ${remotePeerId}`);
      } catch (e) {
        console.error('[ONBOARD] Error during onboarding:', e);
        stream.close();
      }
    });

    await this.node.handle('/vsm/remote/1.0.0', async (props: any) => {
      const stream = props.stream || props;
      const connection = props.connection || {};
      const remotePeerId = connection.remotePeer ? connection.remotePeer.toString() : 'unknown';
      try {
        if (remotePeerId !== 'unknown' && !this.authorizedPeers.has(remotePeerId)) {
          console.warn(`[UNICAST] Dropping direct message from unauthorized peer ${remotePeerId}`);
          if (stream.close) stream.close();
          return;
        }

        const duplex = { source: stream, sink: async (source: any) => {
          if (typeof stream.sink === 'function') {
            await stream.sink(source);
          } else if (typeof stream.send === 'function') {
            for await (const chunk of source) { stream.send(chunk instanceof Uint8Array ? chunk : chunk.subarray()); }
          }
        }};
        const lp = lpStream(duplex as any);
        const data = await lp.read();
        if (data) {
          const decoded = new TextDecoder().decode(data.subarray());
          const msg = JSON.parse(decoded);
          console.log(`[REMOTE] Direct message received from ${remotePeerId}`);
          this.handleMessage('REMOTE', msg);
        }
        if (stream.close) stream.close();
      } catch (e) {
        console.error('[REMOTE] Error reading direct message:', e);
        if (stream.close) stream.close();
      }
    });

    this.node.addEventListener('peer:discovery', (evt) => {
      const peerId = evt.detail.id.toString();
      if (this.authorizedPeers.has(peerId)) {
        this.node?.dial(evt.detail.id).catch(() => {});
      }
    });

    this.node.addEventListener('peer:identify', (evt: any) => {
      const peerId = evt.detail.peerId.toString();
      const addrs = evt.detail.listenAddrs?.map((a: any) => a.toString()) || [];
      if (addrs.length > 0 && this.authorizedPeers.has(peerId)) {
        this.meshMultiaddrs.set(peerId, addrs);
        this.saveMeshState();
      }
    });
    
    await this.node.start();
    console.log(`libp2p node started with PeerId: ${this.node.peerId.toString()}`);
    this.subscribeToTopics();

    const runReconnect = async () => {
      if (!this.node) return;
      const connected = this.node.getPeers().map(p => p.toString());
      for (const [peerId, addrs] of this.meshMultiaddrs.entries()) {
        if (!connected.includes(peerId) && this.authorizedPeers.has(peerId)) {
          try {
            console.log(`[P2P] Auto-reconnecting to mesh peer ${peerId} over Tor...`);
            await this.node.dial(addrs.map((a: string) => multiaddr(a)));
            console.log(`[P2P] Successfully recovered connection to ${peerId}`);
          } catch (e: any) {
            console.warn(`[P2P] Auto-reconnect failed for ${peerId}:`, e.message);
          }
        }
      }
    };
    setTimeout(runReconnect, 1000);
    setInterval(runReconnect, 45000);
  }

  private getInvitePayload(invite: InviteToken): string {
    const keys = [
      'invite_id', 'inviter_id', 'inviter_pubkey', 'inviter_multiaddrs',
      'invitee_id', 'assigned_level', 'assigned_role', 'invite_type', 'project_hash', 'expiry'
    ];
    const obj: any = {};
    for (const key of keys) {
      obj[key] = (invite as any)[key];
    }
    if (Array.isArray(obj.inviter_multiaddrs)) {
      obj.inviter_multiaddrs.sort();
    }
    return JSON.stringify(obj);
  }

  async generateInvite(type: 'PEER' | 'MEMBER', role: string, inviteePeerId: string): Promise<string> {
    if (!this.node) throw new Error('P2P node not started');
    const inviterAddrs = this.node.getMultiaddrs().map(ma => ma.toString());
    if (!inviterAddrs.length) throw new Error('No inviter addresses available.');

    const pubKeyBytes = publicKeyToProtobuf(this.node.peerId.publicKey);
    const invite: InviteToken = {
      invite_id: crypto.randomUUID(),
      inviter_id: this.node.peerId.toString(),
      inviter_pubkey: Buffer.from(pubKeyBytes).toString('base64'),
      inviter_multiaddrs: inviterAddrs,
      invitee_id: inviteePeerId,
      assigned_level: type === 'MEMBER' ? Math.max(1, (this.topology.level || 3) - 1) : (this.topology.level || 3),
      assigned_role: role,
      invite_type: type,
      project_hash: this.projectHash,
      expiry: Date.now() + 86400000,
      signature: ''
    };
    invite.signature = await this.signInvite(invite);
    return Buffer.from(JSON.stringify(invite)).toString('base64');
  }

  async joinMesh(tokenBase64: string): Promise<void> {
    if (!this.node) throw new Error('P2P node not started');
    const invite = JSON.parse(Buffer.from(tokenBase64.trim(), 'base64').toString('utf-8'));
    if (!invite.inviter_multiaddrs || !invite.inviter_id) throw new Error('Invite missing details');

    const isValid = await this.verifyInvite(invite);
    if (!isValid) throw new Error('Invite signature verification failed');
    
    const myPeerId = this.node.peerId.toString();
    if (invite.invitee_id !== myPeerId) {
      throw new Error(`Invite peer ID mismatch: invite is for ${invite.invitee_id}, but I am ${myPeerId}`);
    }

    console.log(`[JOIN] Dialing inviter ${invite.inviter_id} at ${invite.inviter_multiaddrs}`);
    await this.node.dial(invite.inviter_multiaddrs.map((a: string) => multiaddr(a)));
    const stream = await this.node.dialProtocol(peerIdFromString(invite.inviter_id), '/vsm/onboard/1.0.0');
    console.log(`[JOIN] Protocol opened with ${invite.inviter_id}`);
    
    const duplex = {
      source: stream,
      sink: async (source: any) => {
        for await (const chunk of source) {
          const data = chunk instanceof Uint8Array ? chunk : chunk.subarray();
          console.log(`[JOIN] Writing ${data.byteLength} bytes to ${invite.inviter_id}`);
          (stream as any).send(data);
        }
      }
    };
    const lp = lpStream(duplex as any);
    
    const requestPayload = { invite, topology: this.topology };
    console.log(`[JOIN] Sending onboard request to ${invite.inviter_id}`);
    await lp.write(new TextEncoder().encode(JSON.stringify(requestPayload)));

    console.log(`[JOIN] Waiting for response from ${invite.inviter_id}...`);
    const responseData = await lp.read();
    stream.close();

    if (!responseData) throw new Error('No response from peer during handshake');
    const responseDecoded = new TextDecoder().decode(responseData.subarray());
    console.log(`[JOIN] Received response: ${responseDecoded}`);
    const response = JSON.parse(responseDecoded);
    if (response.status !== 'SUCCESS' || !response.topology) {
      throw new Error(`Handshake rejected: ${response.error || 'Unknown reason'}`);
    }

    this.fullTopology.set(invite.inviter_id, response.topology);
    this.topology = { 
      ...this.topology, 
      level: invite.assigned_level, 
      role: invite.assigned_role, 
      parent: invite.invite_type === 'MEMBER' ? invite.inviter_id : null 
    };
    if (invite.invite_type === 'PEER') {
      if (!this.topology.peers.includes(invite.inviter_id)) {
        this.topology.peers.push(invite.inviter_id);
      }
    }
    this.authorizedPeers.add(invite.inviter_id);
    if (invite.inviter_multiaddrs) {
      this.meshMultiaddrs.set(invite.inviter_id, invite.inviter_multiaddrs);
    }
    await this.saveMeshState();
  }

  private subscribeToTopics() {
    if (!this.node) return;
    this.node.services.pubsub.addEventListener('message', (evt: any) => {
      try { 
        const msg = JSON.parse(new TextDecoder().decode(evt.detail.data));
        this.handleMessage(evt.detail.topic, msg); 
      } catch (e) {
      }
    });
  }

  private handleMessage(topic: string, message: VSM_Message) {
    console.log(`[P2P] Received message on topic ${topic} from ${message.origin_cell}`);
    
    if (message.scope === 'REMOTE' && message.target_cell !== this.getPeerId()) {
      return;
    }

    if (this.authorizedPeers.has(message.origin_cell) || message.origin_cell === this.getPeerId()) {
      this.messageHandlers.forEach(h => h(topic, message));
    }
  }
  
  getPeers() {
    const connected = this.node?.getPeers().map(p => p.toString()) || [];
    return connected.filter(p => this.authorizedPeers.has(p));
  }

  getPeerId() {
    return this.node?.peerId.toString() || this.peerId?.toString() || 'unknown';
  }

  getTopology() {
    return this.topology;
  }

  getFullTopology() {
    const map: any = { [this.getPeerId()]: this.topology };
    this.fullTopology.forEach((v, k) => {
      if (this.authorizedPeers.has(k)) {
        map[k] = v;
      }
    });
    return map;
  }
  
  async stop(): Promise<void> {
    await this.node?.stop();
  }
  
  async remote(targetPeerId: string, type: VSM_Message['type'], payload: VSM_Message['payload']): Promise<void> {
    if (!this.node) throw new Error('P2P node not started');
    try {
      console.log(`[REMOTE] Initiating direct stream delivery to ${targetPeerId}...`);
      const conn = await this.node.dialProtocol(peerIdFromString(targetPeerId), '/vsm/remote/1.0.0', {
        signal: AbortSignal.timeout(60000)
      });
      
      const envelope = JSON.stringify({
        origin_cell: this.node.peerId.toString(), target_cell: targetPeerId, scope: 'REMOTE', type, payload,
        s5_context: 'Direct point-to-point message', timestamp: Date.now(),
        project_hash: this.projectHash 
      });

      const duplex = { source: conn, sink: async (source: any) => {
        if (typeof (conn as any).sink === 'function') {
          await (conn as any).sink(source);
        } else if (typeof (conn as any).send === 'function') {
          for await (const chunk of source) { (conn as any).send(chunk instanceof Uint8Array ? chunk : chunk.subarray()); }
        }
      }};
      const lp = lpStream(duplex as any);
      await lp.write(new TextEncoder().encode(envelope));
      if (typeof (conn as any).close === 'function') (conn as any).close();
      
      console.log(`[REMOTE] Successfully delivered direct stream to ${targetPeerId}`);
    } catch (e) {
      console.error(`[REMOTE] Failed direct delivery to ${targetPeerId}:`, e);
    }
  }



  private async readIdentityFile(): Promise<string> {
    return fs.readFile(this.identityPath, 'utf-8');
  }

  private async writeIdentityFile(contents: string): Promise<void> {
    await fs.mkdir(path.dirname(this.identityPath), { recursive: true });
    await fs.writeFile(this.identityPath, contents);
  }

  private async loadProfile(): Promise<void> {
    try {
      const data = JSON.parse(await fs.readFile(this.profilePath, 'utf-8'));
      if (data.displayName) this.topology.displayName = data.displayName;
    } catch {}
  }

  private async saveProfile(): Promise<void> {
    await fs.writeFile(this.profilePath, JSON.stringify({ displayName: this.topology.displayName }));
  }

  private async loadMeshState(): Promise<void> {
    try {
      const data = JSON.parse(await fs.readFile(this.meshStatePath, 'utf-8'));
      if (data.authorizedPeers) this.authorizedPeers = new Set(data.authorizedPeers);
      if (data.topology) this.topology = { ...this.topology, ...data.topology };
      if (data.fullTopology) {
        this.fullTopology = new Map(Object.entries(data.fullTopology));
      }
      if (data.meshMultiaddrs) {
        this.meshMultiaddrs = new Map(Object.entries(data.meshMultiaddrs));
      }
    } catch {}
  }

  private async saveMeshState(): Promise<void> {
    const data = {
      authorizedPeers: Array.from(this.authorizedPeers),
      topology: this.topology,
      fullTopology: Object.fromEntries(this.fullTopology),
      meshMultiaddrs: Object.fromEntries(this.meshMultiaddrs)
    };
    await fs.writeFile(this.meshStatePath, JSON.stringify(data, null, 2));
  }

  private async signInvite(invite: InviteToken): Promise<string> {
    const payloadStr = this.getInvitePayload(invite);
    const sig = await this.signingKey.sign(new TextEncoder().encode(payloadStr));
    return Buffer.from(sig).toString('base64');
  }

  private async verifyInvite(invite: InviteToken): Promise<boolean> {
    if (!invite.signature || !invite.inviter_pubkey) return false;
    try {
      const pubKey = publicKeyFromProtobuf(Buffer.from(invite.inviter_pubkey, 'base64'));
      const payloadStr = this.getInvitePayload(invite);
      return await pubKey.verify(new TextEncoder().encode(payloadStr), Buffer.from(invite.signature, 'base64'));
    } catch (e) {
      console.error('Verify invite error:', e);
      return false;
    }
  }
  
  private async migrateEncryptedIdentityIfNeeded(): Promise<void> {}

  async leaveMesh(): Promise<void> {
    this.authorizedPeers.clear();
    this.meshMultiaddrs.clear();
    this.fullTopology.clear();
    this.topology.parent = null;
    this.topology.level = 3;
    this.topology.role = 'Root Admin';
    this.topology.children = [];
    this.topology.peers = [];
    await this.saveMeshState();
    console.log('[MESH] Left network and cleared state.');
  }
}
