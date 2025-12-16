/**
 * HyperToken Adapter
 * Handles P2P communication via WebSocket relay for real-time gossip
 */

import type { GossipMessage, PeerConnection } from '../types.js';

export interface HyperTokenConfig {
  relayUrl: string;
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
}

export type MessageHandler = (message: GossipMessage) => void;

export interface HyperTokenAdapter {
  /**
   * Connect to the relay
   */
  connect(): Promise<void>;

  /**
   * Disconnect from the relay
   */
  disconnect(): void;

  /**
   * Send a gossip message
   */
  send(message: GossipMessage): Promise<void>;

  /**
   * Subscribe to incoming messages
   */
  onMessage(handler: MessageHandler): void;

  /**
   * Remove message handler
   */
  offMessage(handler: MessageHandler): void;

  /**
   * Get connected peers
   */
  getPeers(): PeerConnection[];

  /**
   * Check connection status
   */
  isConnected(): boolean;

  /**
   * Check if the relay is available
   */
  healthCheck(): Promise<boolean>;
}

/**
 * WebSocket-based HyperToken adapter for production use
 */
export class WebSocketHyperTokenAdapter implements HyperTokenAdapter {
  private ws: WebSocket | null = null;
  private messageHandlers: Set<MessageHandler> = new Set();
  private peers: Map<string, PeerConnection> = new Map();
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private connected = false;

  constructor(private config: HyperTokenConfig) {}

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.config.relayUrl);

        this.ws.onopen = () => {
          this.connected = true;
          this.reconnectAttempts = 0;
          resolve();
        };

        this.ws.onmessage = (event) => {
          try {
            const message = JSON.parse(event.data) as GossipMessage;
            this.handleMessage(message);
          } catch (e) {
            console.warn('Failed to parse message:', e);
          }
        };

        this.ws.onclose = () => {
          this.connected = false;
          this.handleDisconnect();
        };

        this.ws.onerror = (error) => {
          const errorMessage = `WebSocket connection failed to ${this.config.relayUrl}`;
          if (!this.connected) {
            reject(new Error(errorMessage));
          }
          console.error(errorMessage);
        };
      } catch (error) {
        reject(error);
      }
    });
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.peers.clear();
  }

  async send(message: GossipMessage): Promise<void> {
    if (!this.ws || !this.connected) {
      throw new HyperTokenError('Not connected', 'NOT_CONNECTED');
    }

    this.ws.send(JSON.stringify(message));
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandlers.add(handler);
  }

  offMessage(handler: MessageHandler): void {
    this.messageHandlers.delete(handler);
  }

  getPeers(): PeerConnection[] {
    return Array.from(this.peers.values());
  }

  isConnected(): boolean {
    return this.connected;
  }

  async healthCheck(): Promise<boolean> {
    return this.connected;
  }

  private handleMessage(message: GossipMessage): void {
    // Update peer info if present
    if (message.sender) {
      const existing = this.peers.get(message.sender);
      if (existing) {
        existing.lastSeen = Date.now();
      } else {
        this.peers.set(message.sender, {
          peerId: message.sender,
          address: 'relay',
          connectedAt: Date.now(),
          lastSeen: Date.now(),
          score: 100,
        });
      }
    }

    // Dispatch to handlers
    for (const handler of this.messageHandlers) {
      try {
        handler(message);
      } catch (e) {
        console.error('Message handler error:', e);
      }
    }
  }

  private handleDisconnect(): void {
    const maxAttempts = this.config.maxReconnectAttempts ?? 10;
    const interval = this.config.reconnectInterval ?? 5000;

    if (this.reconnectAttempts < maxAttempts) {
      this.reconnectAttempts++;
      console.log(
        `Reconnecting to relay (attempt ${this.reconnectAttempts}/${maxAttempts})...`
      );

      this.reconnectTimer = setTimeout(() => {
        this.connect().catch(console.error);
      }, interval * this.reconnectAttempts); // Exponential backoff
    } else {
      console.error('Max reconnect attempts reached');
    }
  }
}

/**
 * Mock HyperToken adapter for testing and development
 */
export class MockHyperTokenAdapter implements HyperTokenAdapter {
  private messageHandlers: Set<MessageHandler> = new Set();
  private peers: Map<string, PeerConnection> = new Map();
  private connected = true; // Start connected for testing convenience
  private sentMessages: GossipMessage[] = [];

  async connect(): Promise<void> {
    this.connected = true;
  }

  disconnect(): void {
    this.connected = false;
    this.peers.clear();
  }

  async send(message: GossipMessage): Promise<void> {
    if (!this.connected) {
      throw new HyperTokenError('Not connected', 'NOT_CONNECTED');
    }
    this.sentMessages.push(message);
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandlers.add(handler);
  }

  offMessage(handler: MessageHandler): void {
    this.messageHandlers.delete(handler);
  }

  getPeers(): PeerConnection[] {
    return Array.from(this.peers.values());
  }

  isConnected(): boolean {
    return this.connected;
  }

  async healthCheck(): Promise<boolean> {
    return this.connected;
  }

  // Test helpers
  simulateMessage(message: GossipMessage): void {
    for (const handler of this.messageHandlers) {
      handler(message);
    }
  }

  addPeer(peer: PeerConnection): void {
    this.peers.set(peer.peerId, peer);
  }

  getSentMessages(): GossipMessage[] {
    return [...this.sentMessages];
  }

  clearSentMessages(): void {
    this.sentMessages = [];
  }
}

/**
 * HyperToken-specific error
 */
class HyperTokenError extends Error {
  constructor(message: string, public code: string) {
    super(message);
    this.name = 'HyperTokenError';
  }
}
