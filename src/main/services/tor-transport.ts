import { SocksClient } from 'socks';
import { AbortError, InvalidParametersError, TimeoutError, serviceCapabilities, transportSymbol } from '@libp2p/interface';
import { ipPortToMultiaddr } from '@libp2p/utils';
import { Unix } from '@multiformats/multiaddr-matcher';
import { CustomProgressEvent } from 'progress-events';
import { pEvent } from 'p-event';
import type { AbortOptions } from '@libp2p/interface';
import type { Multiaddr } from '@multiformats/multiaddr';
import type { Socket } from 'net';
import { Uint8ArrayList } from 'uint8arraylist';
import {
  AbstractMultiaddrConnection,
  type AbstractMultiaddrConnectionInit,
  type SendResult
} from './tor-message-stream.js';

const ONION3_RE = /\/onion3\/([a-z2-7]{56}):([0-9]+)/;

export type TorTransportInit = {
  socksHost: string;
  socksPort: number;
  outboundSocketInactivityTimeout?: number;
};

export class TorTransport {
  private opts: TorTransportInit;
  private log: any;
  private metrics?: any;
  private components: any;

  constructor(components: any, options: TorTransportInit) {
    this.components = components;
    this.opts = options;
    this.log = components.logger.forComponent('libp2p:tor');
    if (components.metrics != null) {
      this.metrics = {
        events: components.metrics.registerCounterGroup('libp2p_tor_dialer_events_total', {
          label: 'event',
          help: 'Total count of Tor dialer events by type'
        }),
        errors: components.metrics.registerCounterGroup('libp2p_tor_dialer_errors_total', {
          label: 'event',
          help: 'Total count of Tor dialer events by type'
        })
      };
    }
  }

  [transportSymbol] = true;
  [Symbol.toStringTag] = '@libp2p/tor';
  [serviceCapabilities] = ['@libp2p/transport'];

  async dial(ma: any, options: any) {
    options.keepAlive = options.keepAlive ?? true;
    options.noDelay = options.noDelay ?? true;
    options.allowHalfOpen = options.allowHalfOpen ?? false;

    const socket = await this._connect(ma, options);
    socket.setNoDelay(options.noDelay);
    socket.setKeepAlive(options.keepAlive);

    let maConn;
    try {
      maConn = toMultiaddrConnection({
        socket,
        inactivityTimeout: this.opts.outboundSocketInactivityTimeout,
        direction: 'outbound',
        remoteAddr: ma,
        log: this.log.newScope('connection')
      });
    } catch (err) {
      this.metrics?.errors.increment({ outbound_to_connection: true });
      socket.destroy(err as Error);
      throw err;
    }

    try {
      this.log('new outbound connection %s', maConn.remoteAddr);
      return await options.upgrader.upgradeOutbound(maConn, options);
    } catch (err) {
      this.metrics?.errors.increment({ outbound_upgrade: true });
      this.log.error('error upgrading outbound connection - %e', err);
      maConn.abort(err);
      throw err;
    }
  }

  async _connect(ma: any, options: any) {
    options.signal.throwIfAborted();
    options.onProgress?.(new CustomProgressEvent('tor:open-connection'));

    const target = this.parseOnion(ma.toString());
    if (!target) {
      throw new Error(`Invalid onion3 multiaddr: ${ma.toString()}`);
    }

    return new Promise((resolve, reject) => {
      const start = Date.now();

      const onTimeout = () => {
        this.log('connection timeout %a', ma);
        this.metrics?.events.increment({ timeout: true });
        const err = new TimeoutError(`Connection timeout after ${Date.now() - start}ms`);
        reject(err);
      };

      const timeout = setTimeout(onTimeout, options.timeout ?? 30_000);

      SocksClient.createConnection({
        proxy: {
          host: this.opts.socksHost,
          port: this.opts.socksPort,
          type: 5
        },
        command: 'connect',
        destination: {
          host: target.host,
          port: target.port
        }
      }).then(({ socket }) => {
        clearTimeout(timeout);
        resolve(socket);
      }).catch((err) => {
        clearTimeout(timeout);
        reject(err);
      });

      if (options.signal != null) {
        const onAbort = () => {
          reject(new AbortError());
        };
        options.signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  listenFilter(_multiaddrs: any[]) {
    return [];
  }

  dialFilter(multiaddrs: any[]) {
    return multiaddrs.filter((ma) => ONION3_RE.test(ma.toString()));
  }

  createListener() {
    throw new Error('Tor transport does not support listening');
  }

  private parseOnion(addr: string): { host: string; port: number } | null {
    const m = addr.match(ONION3_RE);
    if (!m) return null;
    return { host: `${m[1]}.onion`, port: parseInt(m[2], 10) };
  }
}

export function torTransport(init: TorTransportInit) {
  return (components: any) => new TorTransport(components, init);
}

interface TCPSocketMultiaddrConnectionInit
  extends Omit<AbstractMultiaddrConnectionInit, 'remoteAddr'> {
  socket: Socket;
  remoteAddr?: Multiaddr;
}

class TCPSocketMultiaddrConnection extends AbstractMultiaddrConnection {
  private socket: Socket;

  constructor(init: TCPSocketMultiaddrConnectionInit) {
    let remoteAddr = init.remoteAddr;

    if (init.localAddr != null && Unix.matches(init.localAddr)) {
      remoteAddr = init.localAddr;
    } else if (remoteAddr == null) {
      if (init.socket.remoteAddress == null || init.socket.remotePort == null) {
        throw new InvalidParametersError('Could not determine remote address or port');
      }
      remoteAddr = ipPortToMultiaddr(init.socket.remoteAddress, init.socket.remotePort);
    }

    super({
      ...init,
      remoteAddr
    });

    this.socket = init.socket;

    this.socket.on('data', buf => {
      this.onData(buf);
    });

    this.socket.on('error', err => {
      this.log('tcp error', remoteAddr, err);
      this.abort(err as Error);
    });

    this.socket.setTimeout(init.inactivityTimeout ?? (2 * 60 * 1_000));
    this.socket.once('timeout', () => {
      this.log('tcp timeout', remoteAddr);
      this.abort(new TimeoutError());
    });

    this.socket.once('end', () => {
      this.log('tcp end', remoteAddr);
      this.onTransportClosed();
    });

    this.socket.once('close', hadError => {
      this.log('tcp close', remoteAddr);
      if (hadError) {
        this.abort(new Error('TCP transmission error'));
        return;
      }
      this.onTransportClosed();
    });

    this.socket.on('drain', () => {
      this.log('tcp drain');
      this.safeDispatchEvent('drain');
    });
  }

  sendData(data: Uint8ArrayList): SendResult {
    let sentBytes = 0;
    let canSendMore = true;

    for (const buf of data) {
      sentBytes += buf.byteLength;
      canSendMore = this.socket.write(buf);
      if (!canSendMore) {
        break;
      }
    }

    return {
      sentBytes,
      canSendMore
    };
  }

  async sendClose(options?: AbortOptions): Promise<void> {
    if (this.socket.destroyed) {
      return;
    }
    this.socket.destroySoon();
    await pEvent(this.socket, 'close', options);
  }

  sendReset(): void {
    this.socket.resetAndDestroy();
  }

  sendPause(): void {
    this.socket.pause();
  }

  sendResume(): void {
    this.socket.resume();
  }
}

const toMultiaddrConnection = (init: TCPSocketMultiaddrConnectionInit): AbstractMultiaddrConnection => {
  return new TCPSocketMultiaddrConnection(init);
};
