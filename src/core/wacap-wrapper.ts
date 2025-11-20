import {
  WacapConfig,
  SessionConfig,
  SessionInfo,
  MessageOptions,
  IStorageAdapter,
  WacapEventType,
  EventHandler,
} from '../types';
import { Session } from './session';
import { SQLiteStorageAdapter, PrismaStorageAdapter } from '../storage';
import type { WASocket, proto, AnyMessageContent } from '@whiskeysockets/baileys';

/**
 * Main wrapper class for managing multiple WhatsApp sessions
 */
export class WacapWrapper {
  private config: WacapConfig;
  private sessions: Map<string, Session> = new Map();
  private storageAdapter: IStorageAdapter;

  constructor(config: WacapConfig = {}) {
    this.config = {
      sessionsPath: config.sessionsPath || './sessions',
      storageAdapter: config.storageAdapter || 'sqlite',
      debug: config.debug || false,
      logger: config.logger || { level: 'warn' },
      prismaClient: config.prismaClient,
      autoDisplayQR: config.autoDisplayQR !== false,
      browser: config.browser || ['Wacap', 'Chrome', '1.0.0'],
      connectionTimeout: config.connectionTimeout || 60000,
      maxRetries: config.maxRetries || 5,
    };

    // Initialize storage adapter
    if (this.config.storageAdapter === 'prisma') {
      if (!this.config.prismaClient) {
        throw new Error(
          'Prisma storage adapter requires prismaClient to be provided in config'
        );
      }
      this.storageAdapter = new PrismaStorageAdapter(this.config.prismaClient);
    } else {
      this.storageAdapter = new SQLiteStorageAdapter(this.config.sessionsPath);
    }
  }

  /**
   * Initialize the wrapper
   */
  async init(): Promise<void> {
    await this.storageAdapter.init();
  }

  /**
   * Start a new session or resume existing one
   */
  async sessionStart(sessionId: string, customConfig?: Partial<WacapConfig>): Promise<Session> {
    if (this.sessions.has(sessionId)) {
      const session = this.sessions.get(sessionId)!;
      if (session.isActive()) {
        throw new Error(`Session ${sessionId} is already active`);
      }
    }

    const sessionConfig = {
      ...this.config,
      ...customConfig,
    };

    const session = new Session(sessionId, sessionConfig, this.storageAdapter);
    this.sessions.set(sessionId, session);

    await session.start();
    return session;
  }

  /**
   * Stop a session
   */
  async sessionStop(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    await session.stop();
    this.sessions.delete(sessionId);
  }

  /**
   * Find and return a session
   */
  findSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Get all active sessions
   */
  getAllSessions(): Map<string, Session> {
    return this.sessions;
  }

  /**
   * Get all session IDs
   */
  getSessionIds(): string[] {
    return Array.from(this.sessions.keys());
  }

  /**
   * Get session info
   */
  getSessionInfo(sessionId: string): SessionInfo | null {
    const session = this.sessions.get(sessionId);
    return session ? session.getInfo() : null;
  }

  /**
   * Check if session exists
   */
  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /**
   * Delete session data from storage
   */
  async deleteSession(sessionId: string): Promise<void> {
    // Stop session if active
    if (this.sessions.has(sessionId)) {
      await this.sessionStop(sessionId);
    }

    // Delete from storage
    await this.storageAdapter.deleteSession(sessionId);
  }

  /**
   * Send a text message
   */
  async sendMessage(
    sessionId: string,
    jid: string,
    text: string,
    options?: Partial<MessageOptions>
  ): Promise<any> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const socket = session.getSocket();
    if (!socket) {
      throw new Error(`Session ${sessionId} is not connected`);
    }

    const message: AnyMessageContent = {
      text,
    };

    if (options?.quoted) {
      return await socket.sendMessage(jid, message, {
        quoted: options.quoted,
      });
    }

    if (options?.mentions) {
      return await socket.sendMessage(jid, {
        text,
        mentions: options.mentions,
      });
    }

    return await socket.sendMessage(jid, message);
  }

  /**
   * Send media (image, video, audio, document)
   */
  async sendMedia(
    sessionId: string,
    jid: string,
    media: {
      url?: string;
      buffer?: Buffer;
      mimetype?: string;
      caption?: string;
      fileName?: string;
    }
  ): Promise<any> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const socket = session.getSocket();
    if (!socket) {
      throw new Error(`Session ${sessionId} is not connected`);
    }

    const content: any = {};

    // Determine media type from mimetype
    const mimetype = media.mimetype || '';
    
    if (mimetype.startsWith('image/')) {
      content.image = media.url || media.buffer;
      if (media.caption) content.caption = media.caption;
    } else if (mimetype.startsWith('video/')) {
      content.video = media.url || media.buffer;
      if (media.caption) content.caption = media.caption;
    } else if (mimetype.startsWith('audio/')) {
      content.audio = media.url || media.buffer;
      content.mimetype = mimetype;
    } else {
      content.document = media.url || media.buffer;
      content.mimetype = mimetype;
      if (media.fileName) content.fileName = media.fileName;
      if (media.caption) content.caption = media.caption;
    }

    return await socket.sendMessage(jid, content);
  }

  /**
   * Register event handler for a session
   */
  on(sessionId: string, event: WacapEventType, handler: EventHandler): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    session.getEventManager().on(event, handler);
  }

  /**
   * Register one-time event handler for a session
   */
  once(sessionId: string, event: WacapEventType, handler: EventHandler): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    session.getEventManager().once(event, handler);
  }

  /**
   * Get raw socket for advanced usage
   */
  getSocket(sessionId: string): WASocket | null {
    const session = this.sessions.get(sessionId);
    return session ? session.getSocket() : null;
  }

  /**
   * Cleanup all sessions and close storage
   */
  async destroy(): Promise<void> {
    // Stop all sessions
    for (const [sessionId, session] of this.sessions) {
      await session.stop();
    }

    this.sessions.clear();

    // Close storage
    await this.storageAdapter.close();
  }
}
