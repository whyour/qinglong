import SockJS from 'sockjs-client';
import { SockMessageType } from './type';

class WebSocketManager {
  private static instance: WebSocketManager | null = null;
  private url: string;
  private socket: WebSocket | null = null;
  private subscriptions: Map<SockMessageType, Set<(p: any) => void>> = new Map();
  private options: {
    maxReconnectAttempts: number;
    reconnectInterval: number;
    heartbeatInterval: number;
  };
  private reconnectAttempts: number = 0;
  private heartbeatTimeout: NodeJS.Timeout | null = null;
  private state: 'closed' | 'connecting' | 'open' = 'closed';

  constructor(url: string, options: Partial<typeof WebSocketManager.prototype.options> = {}) {
    this.url = url;
    this.options = {
      maxReconnectAttempts: options.maxReconnectAttempts || 5,
      reconnectInterval: options.reconnectInterval || 3000,
      heartbeatInterval: options.heartbeatInterval || 30000,
    };

    this.init();
  }

  public static getInstance(url: string = '', options?: Partial<typeof WebSocketManager.prototype.options>): WebSocketManager {
    if (!WebSocketManager.instance) {
      WebSocketManager.instance = new WebSocketManager(url, options);
    }
    return WebSocketManager.instance;
  }

  private async init() {
    try {
      this.state = 'connecting';
      this.emit('connecting');

      while (this.reconnectAttempts < this.options.maxReconnectAttempts) {
        this.socket = new SockJS(this.url);
        this.setupEventListeners();
        this.startHeartbeat();
        await this.waitForClose();
        this.stopHeartbeat();
        this.socket = null;
        this.reconnectAttempts++;

        await new Promise((resolve) => setTimeout(resolve, this.options.reconnectInterval));
      }
    } catch (error) {
      this.handleError(error);
    }
  }

  private setupEventListeners() {
    if (!this.socket) return;

    this.socket.onopen = () => {
      this.state = 'open';
      this.emit('open');
    };

    this.socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      this.dispatchMessage(message);
    };

    this.socket.onclose = () => {
      this.state = 'closed';
      this.emit('close');
    };
  }

  private async waitForClose() {
    while (this.socket?.readyState !== SockJS.CLOSED) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  public subscribe(topic: SockMessageType, callback: (v: any) => void) {
    const topicSubscriptions = this.subscriptions.get(topic) || new Set();

    if (!topicSubscriptions.has(callback)) {
      topicSubscriptions.add(callback);
      this.subscriptions.set(topic, topicSubscriptions);

      const subscriptionMessage = { action: 'subscribe', topic };
      this.send(subscriptionMessage);
    }
  }

  public unsubscribe(topic: SockMessageType, callback: (v: any) => void) {
    const topicSubscriptions = this.subscriptions.get(topic) || new Set();
    if (topicSubscriptions.has(callback)) {
      topicSubscriptions.delete(callback);

      const unsubscribeMessage = { action: 'unsubscribe', topic };
      this.send(unsubscribeMessage);
    }
  }

  public send(message: any) {
    if (this.socket?.readyState === SockJS.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  private dispatchMessage(message: any) {
    const { type, ...others } = message;
    const topicSubscriptions = this.subscriptions.get(type) || new Set();

    [...topicSubscriptions].forEach((callback) => callback(others));
  }

  private startHeartbeat() {
    this.heartbeatTimeout = setInterval(() => {
      if (this.socket?.readyState === SockJS.OPEN) {
        this.socket.send(JSON.stringify({ type: 'heartbeat' }));
      }
    }, this.options.heartbeatInterval);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimeout) {
      clearInterval(this.heartbeatTimeout);
    }
  }

  public close() {
    if (this.socket) {
      this.state = 'closed';
      this.stopHeartbeat();
      this.socket.close();
      this.emit('close');
    }
  }

  private handleError(error: any) {
    console.error('WebSocket错误:', error);
    this.emit('error', error);
  }

  public on(event: string, listener: Function) {
    // this.addListener(event, listener);
  }

  public emit(event: string, data?: any) {
    // this.listeners(event).forEach((listener) => listener(data));
  }
}

export default WebSocketManager;
