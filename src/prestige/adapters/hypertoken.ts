/**
 * HyperToken Adapter
 * Handles P2P communication via WebSocket relay for real-time gossip
 *
 * Protocol messages:
 * - welcome: { type: "welcome", peerId, clientCount } - Sent on connect
 * - peer:joined: { type: "peer:joined", peerId } - Peer connected
 * - peer:left: { type: "peer:left", peerId } - Peer disconnected
 * - Broadcast: { type: "<custom>", payload, fromPeerId } - From other peers
 * - Targeted: { type: "p2p", targetPeerId, payload, fromPeerId } - Direct message
 */

import type { GossipMessage, PeerConnection } from '../types.js';

export interface HyperTokenConfig {
  relayUrl: string;
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
}

/**
 * Relay protocol message types
 */
interface WelcomeMessage {
  type: 'welcome';
  peerId: string;
  clientCount: number;
}

interface PeerJoinedMessage {
  type: 'peer:joined';
  peerId: string;
}

interface PeerLeftMessage {
  type: 'peer:left';
  peerId: string;
}

interface RelayMessage {
  type: string;
  payload?: unknown;
  targetPeerId?: string;
  fromPeerId?: string;
}

type ProtocolMessage = WelcomeMessage | PeerJoinedMessage | PeerLeftMessage | RelayMessage;

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
   * Send a gossip message to all peers (broadcast)
   */
  send(message: GossipMessage): Promise<void>;

  /**
   * Send a message to a specific peer
   */
  sendToPeer(peerId: string, message: GossipMessage): Promise<void>;

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
   * Get our assigned peer ID from the relay
   */
  getPeerId(): string | null;

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
  private peerId: string | null = null;

  constructor(private config: HyperTokenConfig) {}

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.config.relayUrl);
        let welcomeReceived = false;

        this.ws.onopen = () => {
          this.connected = true;
          this.reconnectAttempts = 0;
          // Don't resolve yet - wait for welcome message
        };

        this.ws.onmessage = (event) => {
          try {
            const message = JSON.parse(event.data) as ProtocolMessage;

            // Handle protocol messages
            if (message.type === 'welcome') {
              const welcome = message as WelcomeMessage;
              this.peerId = welcome.peerId;
              console.log(`[HyperToken] Connected as ${this.peerId} (${welcome.clientCount} peers)`);
              if (!welcomeReceived) {
                welcomeReceived = true;
                resolve();
              }
              return;
            }

            if (message.type === 'peer:joined') {
              const joined = message as PeerJoinedMessage;
              this.peers.set(joined.peerId, {
                peerId: joined.peerId,
                address: 'relay',
                connectedAt: Date.now(),
                lastSeen: Date.now(),
                score: 100,
              });
              console.log(`[HyperToken] Peer joined: ${joined.peerId}`);
              return;
            }

            if (message.type === 'peer:left') {
              const left = message as PeerLeftMessage;
              this.peers.delete(left.peerId);
              console.log(`[HyperToken] Peer left: ${left.peerId}`);
              return;
            }

            // Handle application messages (broadcast or targeted)
            this.handleMessage(message as RelayMessage);
          } catch (e) {
            console.warn('[HyperToken] Failed to parse message:', e);
          }
        };

        this.ws.onclose = () => {
          this.connected = false;
          this.peerId = null;
          this.handleDisconnect();
        };

        this.ws.onerror = () => {
          const errorMessage = `WebSocket connection failed to ${this.config.relayUrl}`;
          if (!this.connected) {
            reject(new Error(errorMessage));
          }
          console.error(errorMessage);
        };

        // Timeout if we don't get welcome message
        setTimeout(() => {
          if (!welcomeReceived && this.connected) {
            // Old server without welcome message - still resolve
            console.log('[HyperToken] Connected (no welcome message)');
            resolve();
          }
        }, 2000);
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
    this.peerId = null;
    this.peers.clear();
  }

  async send(message: GossipMessage): Promise<void> {
    if (!this.ws || !this.connected) {
      throw new HyperTokenError('Not connected', 'NOT_CONNECTED');
    }

    // Use relay message format for broadcasts
    const relayMessage: RelayMessage = {
      type: message.type,
      payload: message,
    };

    this.ws.send(JSON.stringify(relayMessage));
  }

  async sendToPeer(targetPeerId: string, message: GossipMessage): Promise<void> {
    if (!this.ws || !this.connected) {
      throw new HyperTokenError('Not connected', 'NOT_CONNECTED');
    }

    // Use relay message format for targeted messages
    const relayMessage: RelayMessage = {
      type: 'p2p',
      targetPeerId,
      payload: message,
    };

    this.ws.send(JSON.stringify(relayMessage));
  }

  getPeerId(): string | null {
    return this.peerId;
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

  private handleMessage(relayMsg: RelayMessage): void {
    // Extract the GossipMessage from the relay payload
    const message = (relayMsg.payload ?? relayMsg) as GossipMessage;

    // Update sender from relay's fromPeerId if not present
    if (!message.sender && relayMsg.fromPeerId) {
      message.sender = relayMsg.fromPeerId;
    }

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
        console.error('[HyperToken] Message handler error:', e);
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
  private mockPeerId = `mock-peer-${Date.now()}`;

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

  async sendToPeer(targetPeerId: string, message: GossipMessage): Promise<void> {
    if (!this.connected) {
      throw new HyperTokenError('Not connected', 'NOT_CONNECTED');
    }
    this.sentMessages.push({ ...message, targetPeerId } as GossipMessage & { targetPeerId: string });
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

  getPeerId(): string | null {
    return this.connected ? this.mockPeerId : null;
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
