import {
  StreamAbortEvent,
  StreamBufferError,
  StreamCloseEvent,
  StreamMessageEvent,
  StreamResetError,
  StreamResetEvent,
  StreamStateError,
  TypedEventEmitter
} from '@libp2p/interface';
import { pushable } from 'it-pushable';
import { raceSignal } from 'race-signal';
import { Uint8ArrayList } from 'uint8arraylist';
import { pEvent } from 'p-event';
import type {
  AbortOptions,
  CounterGroup,
  EventHandler,
  Logger,
  MessageStream,
  MessageStreamDirection,
  MessageStreamEvents,
  MessageStreamReadStatus,
  MessageStreamStatus,
  MessageStreamTimeline,
  MessageStreamWriteStatus,
  MultiaddrConnection,
  StreamOptions
} from '@libp2p/interface';
import type { Multiaddr } from '@multiformats/multiaddr';

const DEFAULT_MAX_READ_BUFFER_LENGTH = Math.pow(2, 20) * 4; // 4MB

export class StreamClosedError extends Error {
  static name = 'StreamClosedError';
  name = 'StreamClosedError';
}

const createDeferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: any) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

export interface MessageStreamInit extends StreamOptions {
  log: Logger;
  direction?: MessageStreamDirection;
  maxMessageSize?: number;
}

export interface SendResult {
  sentBytes: number;
  canSendMore: boolean;
}

export abstract class AbstractMessageStream<Timeline extends MessageStreamTimeline = MessageStreamTimeline>
  extends TypedEventEmitter<MessageStreamEvents>
  implements MessageStream {
  public status: MessageStreamStatus;
  public readonly timeline: Timeline;
  public inactivityTimeout: number;
  public maxReadBufferLength: number;
  public maxWriteBufferLength?: number;
  public readonly log: Logger;
  public direction: MessageStreamDirection;
  public maxMessageSize?: number;

  public readStatus: MessageStreamReadStatus;
  public writeStatus: MessageStreamWriteStatus;
  public remoteReadStatus: MessageStreamReadStatus;
  public remoteWriteStatus: MessageStreamWriteStatus;

  public writableNeedsDrain: boolean;

  protected readonly readBuffer: Uint8ArrayList;
  protected readonly writeBuffer: Uint8ArrayList;
  protected sendingData: boolean;

  private onDrainPromise?: ReturnType<typeof createDeferred<void>>;

  constructor(init: MessageStreamInit) {
    super();

    this.status = 'open';
    this.log = init.log;
    this.direction = init.direction ?? 'outbound';
    this.inactivityTimeout = init.inactivityTimeout ?? 120_000;
    this.maxReadBufferLength = init.maxReadBufferLength ?? DEFAULT_MAX_READ_BUFFER_LENGTH;
    this.maxWriteBufferLength = init.maxWriteBufferLength;
    this.maxMessageSize = init.maxMessageSize;
    this.readBuffer = new Uint8ArrayList();
    this.writeBuffer = new Uint8ArrayList();

    this.readStatus = 'readable';
    this.remoteReadStatus = 'readable';
    this.writeStatus = 'writable';
    this.remoteWriteStatus = 'writable';
    this.sendingData = false;
    this.writableNeedsDrain = false;

    // @ts-expect-error type could have required fields other than 'open'
    this.timeline = {
      open: Date.now()
    };

    this.processSendQueue = this.processSendQueue.bind(this);

    const continueSendingOnDrain = (): void => {
      if (this.writableNeedsDrain) {
        this.log.trace('drain event received, continue sending data');
        this.writableNeedsDrain = false;
        this.processSendQueue();
      }

      this.onDrainPromise?.resolve();
    };
    this.addEventListener('drain', continueSendingOnDrain);

    const rejectOnDrainOnClose = (evt: StreamCloseEvent): void => {
      this.onDrainPromise?.reject(evt.error ?? new StreamClosedError());
    };
    this.addEventListener('close', rejectOnDrainOnClose);
  }

  get readBufferLength(): number {
    return this.readBuffer.byteLength;
  }

  get writeBufferLength(): number {
    return this.writeBuffer.byteLength;
  }

  async onDrain(options?: AbortOptions): Promise<void> {
    if (this.writableNeedsDrain !== true) {
      return Promise.resolve();
    }

    if (this.onDrainPromise == null) {
      this.onDrainPromise = createDeferred<void>();
    }

    return raceSignal(this.onDrainPromise.promise, options?.signal);
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array | Uint8ArrayList> {
    if (this.readStatus !== 'readable' && this.readStatus !== 'paused') {
      return;
    }

    const output = pushable<Uint8Array | Uint8ArrayList>();

    const streamAsyncIterableOnMessageListener = (evt: StreamMessageEvent): void => {
      output.push(evt.data);
    };
    this.addEventListener('message', streamAsyncIterableOnMessageListener);

    const streamAsyncIterableOnCloseListener = (evt: StreamCloseEvent): void => {
      output.end(evt.error);
    };
    this.addEventListener('close', streamAsyncIterableOnCloseListener);

    const streamAsyncIterableOnRemoteCloseWriteListener = (): void => {
      output.end();
    };
    this.addEventListener('remoteCloseWrite', streamAsyncIterableOnRemoteCloseWriteListener);

    try {
      yield* output;
    } finally {
      this.removeEventListener('message', streamAsyncIterableOnMessageListener);
      this.removeEventListener('close', streamAsyncIterableOnCloseListener);
      this.removeEventListener('remoteCloseWrite', streamAsyncIterableOnRemoteCloseWriteListener);
    }
  }

  isReadable(): boolean {
    return this.status === 'open';
  }

  send(data: Uint8Array | Uint8ArrayList): boolean {
    if (this.writeStatus === 'closed' || this.writeStatus === 'closing') {
      throw new StreamStateError(`Cannot write to a stream that is ${this.writeStatus}`);
    }

    this.log.trace('append %d bytes to write buffer', data.byteLength);
    this.writeBuffer.append(data);

    return this.processSendQueue();
  }

  abort(err: Error): void {
    if (this.status === 'aborted' || this.status === 'reset' || this.status === 'closed') {
      return;
    }

    this.log.error('abort with error - %e', err);

    this.status = 'aborted';

    if (this.readBuffer.byteLength > 0) {
      this.readBuffer.consume(this.readBuffer.byteLength);
    }

    if (this.writeBuffer.byteLength > 0) {
      this.writeBuffer.consume(this.writeBuffer.byteLength);
      this.safeDispatchEvent('idle');
    }

    this.writeStatus = 'closed';
    this.remoteWriteStatus = 'closed';

    this.readStatus = 'closed';
    this.remoteReadStatus = 'closed';
    this.timeline.close = Date.now();

    try {
      this.sendReset(err);
    } catch (err: any) {
      this.log('failed to send reset to remote - %e', err);
    }

    this.dispatchEvent(new StreamAbortEvent(err));
  }

  pause(): void {
    if (this.readStatus === 'closed' || this.readStatus === 'closing') {
      throw new StreamStateError('Cannot pause a stream that is closing/closed');
    }

    if (this.readStatus === 'paused') {
      return;
    }

    this.readStatus = 'paused';
    this.sendPause();
  }

  resume(): void {
    if (this.readStatus === 'closed' || this.readStatus === 'closing') {
      throw new StreamStateError('Cannot resume a stream that is closing/closed');
    }

    if (this.readStatus === 'readable') {
      return;
    }

    this.readStatus = 'readable';
    this.dispatchReadBuffer();
    this.sendResume();
  }

  push(data: Uint8Array | Uint8ArrayList): void {
    if (this.readStatus === 'closed' || this.readStatus === 'closing') {
      throw new StreamStateError(`Cannot push data onto a stream that is ${this.readStatus}`);
    }

    if (data.byteLength === 0) {
      return;
    }

    this.readBuffer.append(data);

    if (this.readStatus === 'paused' || this.listenerCount('message') === 0) {
      this.checkReadBufferLength();
      return;
    }

    setTimeout(() => {
      this.dispatchReadBuffer();
    }, 0);
  }

  unshift(data: Uint8Array | Uint8ArrayList): void {
    if (this.readStatus === 'closed' || this.readStatus === 'closing') {
      throw new StreamStateError(`Cannot push data onto a stream that is ${this.readStatus}`);
    }

    if (data.byteLength === 0) {
      return;
    }

    this.readBuffer.prepend(data);

    if (this.readStatus === 'paused' || this.listenerCount('message') === 0) {
      this.checkReadBufferLength();
      return;
    }

    setTimeout(() => {
      this.dispatchReadBuffer();
    }, 0);
  }

  onData(data: Uint8Array | Uint8ArrayList): void {
    if (data.byteLength === 0) {
      return;
    }

    if (this.readStatus === 'closing' || this.readStatus === 'closed') {
      this.log('ignoring data - read status %s', this.readStatus);
      return;
    }

    this.readBuffer.append(data);
    this.dispatchReadBuffer();
  }

  addEventListener<K extends keyof MessageStreamEvents>(
    type: K,
    listener: EventHandler<MessageStreamEvents[K]> | null,
    options?: boolean | AddEventListenerOptions
  ): void;
  addEventListener(type: string, listener: EventHandler<Event>, options?: boolean | AddEventListenerOptions): void;
  addEventListener(...args: any[]): void {
    // @ts-expect-error cannot ensure args has enough members
    super.addEventListener.apply(this, args);

    if (args[0] === 'message' && this.readBuffer.byteLength > 0) {
      queueMicrotask(() => {
        this.dispatchReadBuffer();
      });
    }
  }

  onRemoteReset(): void {
    this.log('remote reset');

    this.status = 'reset';
    this.writeStatus = 'closed';
    this.remoteWriteStatus = 'closed';
    this.remoteReadStatus = 'closed';
    this.timeline.close = Date.now();

    if (this.readBuffer.byteLength === 0) {
      this.readStatus = 'closed';
    }

    const err = new StreamResetError();
    this.dispatchEvent(new StreamResetEvent(err));
  }

  onTransportClosed(err?: Error): void {
    this.log('transport closed');

    if (this.readStatus === 'readable' && this.readBuffer.byteLength === 0) {
      this.log('close readable end after transport closed and read buffer is empty');
      this.readStatus = 'closed';
    }

    if (this.remoteReadStatus !== 'closed') {
      this.remoteReadStatus = 'closed';
    }

    if (this.remoteWriteStatus !== 'closed') {
      this.remoteWriteStatus = 'closed';
    }

    if (this.writeStatus !== 'closed') {
      this.writeStatus = 'closed';
    }

    if (err != null) {
      this.abort(err);
    } else {
      if (this.status === 'open' || this.status === 'closing') {
        this.timeline.close = Date.now();
        this.status = 'closed';
        this.writeStatus = 'closed';
        this.remoteWriteStatus = 'closed';
        this.remoteReadStatus = 'closed';
        this.dispatchEvent(new StreamCloseEvent());
      }
    }
  }

  onRemoteCloseWrite(): void {
    if (this.remoteWriteStatus === 'closed') {
      return;
    }

    this.log.trace('on remote close write');

    this.remoteWriteStatus = 'closed';
    this.safeDispatchEvent('remoteCloseWrite');

    if (this.writeStatus === 'closed') {
      this.onTransportClosed();
    }
  }

  onRemoteCloseRead(): void {
    this.log.trace('on remote close read');

    this.remoteReadStatus = 'closed';

    if (this.writeBuffer.byteLength > 0) {
      this.writeBuffer.consume(this.writeBuffer.byteLength);
      this.safeDispatchEvent('idle');
    }
  }

  protected processSendQueue(): boolean {
    if (this.writableNeedsDrain) {
      this.log.trace('not processing send queue as drain is required');
      this.checkWriteBufferLength();
      return false;
    }

    if (this.writeBuffer.byteLength === 0) {
      this.log.trace('not processing send queue as no bytes to send');
      return true;
    }

    if (this.sendingData) {
      this.log.trace('not processing send queue as already sending data');
      return true;
    }

    this.sendingData = true;

    this.log.trace('processing send queue with %d queued bytes', this.writeBuffer.byteLength);

    try {
      let canSendMore = true;
      const totalBytes = this.writeBuffer.byteLength;
      let sentBytes = 0;

      while (this.writeBuffer.byteLength > 0) {
        const end = Math.min(this.maxMessageSize ?? this.writeBuffer.byteLength, this.writeBuffer.byteLength);

        if (end === 0) {
          canSendMore = false;
          break;
        }

        const toSend = this.writeBuffer.sublist(0, end);
        const willSend = new Uint8ArrayList(toSend);

        this.writeBuffer.consume(toSend.byteLength);

        const sendResult = this.sendData(toSend);
        canSendMore = sendResult.canSendMore;
        sentBytes += sendResult.sentBytes;

        if (sendResult.sentBytes !== willSend.byteLength) {
          willSend.consume(sendResult.sentBytes);
          this.writeBuffer.prepend(willSend);
        }

        if (!canSendMore) {
          break;
        }
      }

      if (!canSendMore) {
        this.log.trace(
          'sent %d/%d bytes, pausing sending because underlying stream is full, %d bytes left in the write buffer',
          sentBytes,
          totalBytes,
          this.writeBuffer.byteLength
        );
        this.writableNeedsDrain = true;
        this.checkWriteBufferLength();
      }

      if (this.writeBuffer.byteLength === 0) {
        this.safeDispatchEvent('idle');
      }

      return canSendMore;
    } finally {
      this.sendingData = false;
    }
  }

  protected dispatchReadBuffer(): void {
    try {
      if (this.listenerCount('message') === 0) {
        this.log.trace('not dispatching pause buffer as there are no listeners for the message event');
        return;
      }

      if (this.readBuffer.byteLength === 0) {
        this.log.trace('not dispatching pause buffer as there is no data to dispatch');
        return;
      }

      if (this.readStatus === 'paused') {
        this.log.trace('not dispatching pause buffer we are paused');
        return;
      }

      if (this.readStatus === 'closing' || this.readStatus === 'closed') {
        this.log('dropping %d bytes because the readable end is %s', this.readBuffer.byteLength, this.readStatus);
        this.readBuffer.consume(this.readBuffer.byteLength);
        return;
      }

      const buf = this.readBuffer.sublist();
      this.readBuffer.consume(buf.byteLength);

      this.dispatchEvent(new StreamMessageEvent(buf));
    } finally {
      if (this.readBuffer.byteLength === 0 && this.remoteWriteStatus === 'closed') {
        this.log('close readable end after dispatching read buffer and remote writable end is closed');
        this.readStatus = 'closed';
      }

      this.checkReadBufferLength();
    }
  }

  private checkReadBufferLength(): void {
    if (this.readBuffer.byteLength > this.maxReadBufferLength) {
      this.abort(
        new StreamBufferError(
          `Read buffer length of ${this.readBuffer.byteLength} exceeded limit of ${this.maxReadBufferLength}, read status is ${this.readStatus}`
        )
      );
    }
  }

  private checkWriteBufferLength(): void {
    if (this.maxWriteBufferLength == null) {
      return;
    }

    if (this.writeBuffer.byteLength > this.maxWriteBufferLength) {
      this.abort(
        new StreamBufferError(
          `Write buffer length of ${this.writeBuffer.byteLength} exceeded limit of ${this.maxWriteBufferLength}, write status is ${this.writeStatus}`
        )
      );
    }
  }

  public onMuxerNeedsDrain(): void {
    this.writableNeedsDrain = true;
  }

  public onMuxerDrain(): void {
    this.safeDispatchEvent('drain');
  }

  abstract sendData(data: Uint8ArrayList): SendResult;
  abstract sendReset(err: Error): void;
  abstract sendPause(): void;
  abstract sendResume(): void;
  abstract close(options?: AbortOptions): Promise<void>;
}

export interface AbstractMultiaddrConnectionInit extends Omit<MessageStreamInit, 'log'> {
  remoteAddr: Multiaddr;
  direction: MessageStreamDirection;
  log: Logger;
  inactivityTimeout?: number;
  localAddr?: Multiaddr;
  metricPrefix?: string;
  metrics?: CounterGroup;
}

export abstract class AbstractMultiaddrConnection
  extends AbstractMessageStream
  implements MultiaddrConnection {
  public remoteAddr: Multiaddr;

  private metricPrefix: string;
  private metrics?: CounterGroup;

  constructor(init: AbstractMultiaddrConnectionInit) {
    super(init);

    this.metricPrefix = init.metricPrefix ?? '';
    this.metrics = init.metrics;
    this.remoteAddr = init.remoteAddr;

    this.addEventListener('close', (evt) => {
      this.metrics?.increment({ [`${this.metricPrefix}end`]: true });

      if (evt.error != null) {
        if (evt.local) {
          this.metrics?.increment({ [`${this.metricPrefix}abort`]: true });
        } else {
          this.metrics?.increment({ [`${this.metricPrefix}reset`]: true });
        }
      } else {
        if (evt.local) {
          this.metrics?.increment({ [`${this.metricPrefix}_local_close`]: true });
        } else {
          this.metrics?.increment({ [`${this.metricPrefix}_remote_close`]: true });
        }
      }
    });
  }

  async close(options?: AbortOptions): Promise<void> {
    if (this.status !== 'open') {
      return;
    }

    this.status = 'closing';
    this.writeStatus = 'closing';
    this.remoteWriteStatus = 'closing';
    this.remoteReadStatus = 'closing';

    if (this.sendingData || this.writeBuffer.byteLength > 0) {
      this.log(
        'waiting for write queue to become idle before closing writable end of stream, %d unsent bytes',
        this.writeBuffer.byteLength
      );
      await pEvent(this, 'idle', {
        ...options,
        rejectionEvents: ['close']
      });
    }

    if (this.writableNeedsDrain) {
      this.log(
        'waiting for write queue to drain before closing writable end of stream, %d unsent bytes',
        this.writeBuffer.byteLength
      );
      await pEvent(this, 'drain', {
        ...options,
        rejectionEvents: ['close']
      });
    }

    await this.sendClose(options);
    this.onTransportClosed();
  }

  abstract sendClose(options?: AbortOptions): Promise<void>;
}
