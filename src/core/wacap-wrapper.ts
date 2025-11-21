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
import { SessionRegistry } from './session-registry';
import { EventBus } from '../events/event-bus';
import { SQLiteStorageAdapter, PrismaStorageAdapter } from '../storage';
import type { WASocket, proto, AnyMessageContent } from '@whiskeysockets/baileys';
import { promises as fs } from 'fs';

/**
 * Main wrapper class for managing multiple WhatsApp sessions
 */
export class WacapWrapper {
  private config: WacapConfig;
  private registry: SessionRegistry;
  private storageAdapter: IStorageAdapter;
  private globalBus: EventBus;
  public send: {
    text: (
      sessionId: string,
      jid: string,
      text: string,
      options?: Partial<MessageOptions>
    ) => Promise<any>;
    media: (
      sessionId: string,
      jid: string,
      media: {
        url?: string;
        buffer?: Buffer;
        mimetype?: string;
        caption?: string;
        fileName?: string;
      }
    ) => Promise<any>;
  };
  public sessions: {
    start: (sessionId: string, customConfig?: Partial<WacapConfig>) => Promise<Session>;
    stop: (sessionId: string) => Promise<void>;
    list: () => string[];
    info: (sessionId: string) => SessionInfo | null;
    get: (sessionId: string) => Session | undefined;
  };

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

    this.globalBus = new EventBus();
    this.registry = new SessionRegistry(this.config, this.storageAdapter, this.globalBus);

    // High-level helper APIs for ergonomics
    this.send = {
      text: this.sendMessage.bind(this),
      media: this.sendMedia.bind(this),
    };

    this.sessions = {
      start: this.sessionStart.bind(this),
      stop: this.sessionStop.bind(this),
      list: this.getSessionIds.bind(this),
      info: this.getSessionInfo.bind(this),
      get: this.findSession.bind(this),
    };
  }

  /**
   * Initialize the wrapper
   */
  async init(): Promise<void> {
    await this.storageAdapter.init();
  }

  /**
  * Load and start all sessions stored in persistent storage.
  * Useful for SaaS / warm-boot scenarios.
  */
  async loadAllStoredSessions(): Promise<string[]> {
    const sessionIds = await this.discoverStoredSessionIds();
    const started: string[] = [];

    for (const id of sessionIds) {
      if (this.registry.has(id)) continue;
      try {
        await this.sessionStart(id);
        started.push(id);
      } catch (error) {
        if (this.config.debug) {
          console.error(`[wacap] Failed to start stored session ${id}`, error);
        }
      }
    }

    return started;
  }

  private async discoverStoredSessionIds(): Promise<string[]> {
    if (typeof this.storageAdapter.listSessions === 'function') {
      try {
        const ids = await this.storageAdapter.listSessions();
        if (ids.length > 0) {
          return ids;
        }
      } catch (error) {
        if (this.config.debug) {
          console.warn('[wacap] listSessions failed, falling back to filesystem scan', error);
        }
      }
    }

    try {
      const entries = await fs.readdir(this.config.sessionsPath || './sessions', {
        withFileTypes: true,
      });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch (error) {
      if (this.config.debug) {
        console.warn('[wacap] Unable to read sessions directory', error);
      }
      return [];
    }
  }

  /**
   * Start a new session or resume existing one
   */
  async sessionStart(sessionId: string, customConfig?: Partial<WacapConfig>): Promise<Session> {
    const session = await this.registry.create(sessionId, customConfig);
    return session;
  }

  /**
   * Stop a session
   */
  async sessionStop(sessionId: string): Promise<void> {
    await this.registry.destroy(sessionId);
  }

  /**
   * Find and return a session
   */
  findSession(sessionId: string): Session | undefined {
    return this.registry.get(sessionId);
  }

  /**
   * Get all active sessions
   */
  getAllSessions(): Map<string, Session> {
    return this.registry.all();
  }

  /**
   * Get all session IDs
   */
  getSessionIds(): string[] {
    return this.registry.listIds();
  }

  /**
   * Get session info
   */
  getSessionInfo(sessionId: string): SessionInfo | null {
    const session = this.registry.get(sessionId);
    return session ? session.getInfo() : null;
  }

  /**
   * Check if session exists
   */
  hasSession(sessionId: string): boolean {
    return this.registry.has(sessionId);
  }

  /**
   * Delete session data from storage
   */
  async deleteSession(sessionId: string): Promise<void> {
    // Stop session if active
    if (this.registry.has(sessionId)) {
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
    const session = this.registry.get(sessionId);
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
    const session = this.registry.get(sessionId);
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
    const session = this.registry.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    session.getEventManager().on(event, handler);
  }

  /**
   * Register one-time event handler for a session
   */
  once(sessionId: string, event: WacapEventType, handler: EventHandler): void {
    const session = this.registry.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    session.getEventManager().once(event, handler);
  }

  /**
   * Get raw socket for advanced usage
   */
  getSocket(sessionId: string): WASocket | null {
    const session = this.registry.get(sessionId);
    return session ? session.getSocket() : null;
  }

  /**
   * Listen to events from all sessions globally.
   */
  onGlobal(event: WacapEventType, handler: EventHandler): void {
    this.globalBus.on(event, handler);
  }

  onceGlobal(event: WacapEventType, handler: EventHandler): void {
    this.globalBus.once(event, handler);
  }

  /**
   * Cleanup all sessions and close storage
   */
  async destroy(): Promise<void> {
    // Stop all sessions
    await this.registry.shutdownAll();

    // Close storage
    await this.storageAdapter.close();
  }
}
