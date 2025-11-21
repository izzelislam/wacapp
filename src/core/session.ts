import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  WASocket,
  proto,
  downloadMediaMessage,
  getAggregateVotesInPollMessage,
  delay,
  BaileysEventMap,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { join } from 'path';
import { existsSync, mkdirSync, rmSync } from 'fs';
import {
  WacapConfig,
  SessionInfo,
  MessageOptions,
  WacapEventType,
  IStorageAdapter,
  IWASocket,
  SessionStatus,
} from '../types';
import { EventManager } from '../events';
import { EventBus } from '../events/event-bus';

/**
 * WhatsApp session manager
 * Handles individual WhatsApp connections
 */
export class Session {
  private sessionId: string;
  private config: Required<WacapConfig>;
  private socket: (WASocket & { sessionId: string }) | null = null;
  private eventManager: EventManager;
  private storageAdapter: IStorageAdapter;
  private sessionPath: string;
  private isConnecting: boolean = false;
  private shouldReconnect: boolean = true;
  private retryCount: number = 0;
  private createdAt: Date = new Date();
  private startedAt: Date | undefined;
  private updatedAt: Date | undefined;
  private lastSeenAt: Date | undefined;
  private status: SessionStatus = 'disconnected';
  private lastError?: string;
  private globalBus: EventBus;

  constructor(
    sessionId: string,
    config: WacapConfig,
    storageAdapter: IStorageAdapter,
    globalBus: EventBus
  ) {
    this.sessionId = sessionId;
    this.storageAdapter = storageAdapter;
    this.eventManager = new EventManager(sessionId);
    this.globalBus = globalBus;
    this.updatedAt = this.createdAt;
    
    // Set default config values
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

    this.sessionPath = join(this.config.sessionsPath, this.sessionId);

    // Ensure session directory exists
    if (!existsSync(this.sessionPath)) {
      mkdirSync(this.sessionPath, { recursive: true });
    }
  }

  /**
   * Start the WhatsApp session
   */
  async start(): Promise<void> {
    if (this.isConnecting || this.socket) {
      throw new Error(`Session ${this.sessionId} is already active or connecting`);
    }

    this.shouldReconnect = true;
    this.retryCount = 0;
    this.updateStatus('connecting');

    try {
      await this.connect();
    } catch (error) {
      this.updateStatus('error', error);
      throw error;
    }
  }

  /**
   * Connect to WhatsApp
   */
  private async connect(): Promise<void> {
    if (this.isConnecting) return;
    this.isConnecting = true;
    this.updateStatus('connecting');

    const logger = pino({
      level: this.config.logger.level,
    });

    // Load auth state
    try {
      const { state, saveCreds } = await useMultiFileAuthState(this.sessionPath);
      await this.storageAdapter.saveSession(this.sessionId, state.creds);
      const persistCreds = async () => {
        await saveCreds();
        await this.storageAdapter.saveSession(this.sessionId, state.creds);
      };

      // Get latest version
      const { version } = await fetchLatestBaileysVersion();

      // Create socket
      this.socket = makeWASocket({
        version,
        logger,
        printQRInTerminal: false, // We handle QR display ourselves
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        browser: this.config.browser,
        generateHighQualityLinkPreview: true,
        syncFullHistory: false,
        shouldIgnoreJid: (jid) => jid === 'status@broadcast',
      }) as WASocket & { sessionId: string };

      this.socket.sessionId = this.sessionId;

      // Setup event handlers
      this.setupEventHandlers(persistCreds);

      this.startedAt = this.startedAt || new Date();
      this.touchActivity();
      this.emitBoth(WacapEventType.SESSION_START, {
        sessionId: this.sessionId,
        timestamp: this.startedAt,
      });
    } catch (error) {
      this.updateStatus('error', error);
      throw error;
    } finally {
      this.isConnecting = false;
    }
  }

  /**
   * Setup event handlers for the socket
   */
  private setupEventHandlers(persistCreds: () => Promise<void>): void {
    if (!this.socket) return;

    // Connection updates
    this.socket.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      this.emitBoth(WacapEventType.CONNECTION_UPDATE, {
        sessionId: this.sessionId,
        timestamp: new Date(),
        state: update as any,
        qr,
      });

      // Handle QR code
      if (qr) {
        this.updateStatus('qr');
        if (this.config.autoDisplayQR) {
          console.log(`\n[${this.sessionId}] Scan this QR code to login:\n`);
          qrcode.generate(qr, { small: true });
        }

        this.emitBoth(WacapEventType.QR_CODE, {
          sessionId: this.sessionId,
          timestamp: new Date(),
          state: update as any,
          qr,
        });
      }

      // Handle connection open
      if (connection === 'open') {
        console.log(`[${this.sessionId}] Connection opened successfully`);
        this.retryCount = 0;
        this.updateStatus('connected');
        this.touchActivity();

        this.emitBoth(WacapEventType.CONNECTION_OPEN, {
          sessionId: this.sessionId,
          timestamp: new Date(),
          state: update as any,
        });
      }

      // Handle disconnection
      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        this.socket = null;
        this.updateStatus(isLoggedOut ? 'disconnected' : 'connecting', lastDisconnect?.error);
        
        console.log(
          `[${this.sessionId}] Connection closed. Reconnecting: ${shouldReconnect}`
        );

        this.emitBoth(WacapEventType.CONNECTION_CLOSE, {
          sessionId: this.sessionId,
          timestamp: new Date(),
          state: update as any,
          error: lastDisconnect?.error,
        });

        if (isLoggedOut) {
          await this.handleLoggedOut(lastDisconnect?.error);
          return;
        }

        if (shouldReconnect && this.shouldReconnect) {
          await this.handleReconnect(lastDisconnect?.error);
        }
      }
    });

    // Credentials update
    this.socket.ev.on('creds.update', persistCreds);

    // Messages
    this.socket.ev.on('messages.upsert', async ({ messages, type }) => {
      for (const message of messages) {
        this.touchActivity();
        // Save message to storage
        await this.storageAdapter.saveMessage(this.sessionId, message);

        // Emit message event
        const eventData = {
          sessionId: this.sessionId,
          timestamp: new Date(),
          message,
          isFromMe: message.key.fromMe,
          messageType: Object.keys(message.message || {})[0],
          body: this.getMessageBody(message),
          from: message.key.remoteJid,
        };

        if (message.key.fromMe) {
          this.emitBoth(WacapEventType.MESSAGE_SENT, eventData);
        } else {
          this.emitBoth(WacapEventType.MESSAGE_RECEIVED, eventData);
        }
      }
    });

    // Message updates
    this.socket.ev.on('messages.update', async (updates) => {
      for (const update of updates) {
        this.touchActivity();
        this.emitBoth(WacapEventType.MESSAGE_UPDATE, {
          sessionId: this.sessionId,
          timestamp: new Date(),
          message: update as any,
        });
      }
    });

    // Message deletes
    this.socket.ev.on('messages.delete', async (item) => {
      this.touchActivity();
      this.emitBoth(WacapEventType.MESSAGE_DELETE, {
        sessionId: this.sessionId,
        timestamp: new Date(),
      });
    });

    // Contacts
    this.socket.ev.on('contacts.update', async (updates) => {
      for (const contact of updates) {
        if (contact.id) {
          await this.storageAdapter.saveContact(this.sessionId, contact as any);
        }
      }

      this.touchActivity();

      this.emitBoth(WacapEventType.CONTACT_UPDATE, {
        sessionId: this.sessionId,
        timestamp: new Date(),
      });
    });

    // Chats
    this.socket.ev.on('chats.upsert', async (chats) => {
      for (const chat of chats) {
        await this.storageAdapter.saveChat(this.sessionId, chat);
      }

      this.touchActivity();
      this.emitBoth(WacapEventType.CHAT_UPDATE, {
        sessionId: this.sessionId,
        timestamp: new Date(),
      });
    });

    // Groups
    this.socket.ev.on('groups.update', async (updates) => {
      this.touchActivity();
      this.emitBoth(WacapEventType.GROUP_UPDATE, {
        sessionId: this.sessionId,
        timestamp: new Date(),
      });
    });

    // Group participants
    this.socket.ev.on('group-participants.update', async (update) => {
      this.touchActivity();
      this.emitBoth(WacapEventType.GROUP_PARTICIPANTS_UPDATE, {
        sessionId: this.sessionId,
        timestamp: new Date(),
        groupId: update.id,
        participants: update.participants.map(p => typeof p === 'string' ? p : p.id),
        action: update.action as any,
        author: update.author,
      });
    });

    // Presence
    this.socket.ev.on('presence.update', async (update) => {
      this.touchActivity();
      this.emitBoth(WacapEventType.PRESENCE_UPDATE, {
        sessionId: this.sessionId,
        timestamp: new Date(),
        jid: update.id,
        presences: update.presences as any,
      });
    });

    // Calls
    this.socket.ev.on('call', async (calls) => {
      this.touchActivity();
      this.emitBoth(WacapEventType.CALL, {
        sessionId: this.sessionId,
        timestamp: new Date(),
      });
    });
  }

  /**
   * Update session status & last error message
   */
  private updateStatus(status: SessionStatus, error?: unknown): void {
    this.status = status;
    this.updatedAt = new Date();
    this.lastError = error
      ? error instanceof Error
        ? error.message
        : String(error)
      : undefined;
  }

  /**
   * Track activity timestamps
   */
  private touchActivity(): void {
    const now = new Date();
    this.lastSeenAt = now;
    this.updatedAt = now;
  }

  /**
   * Handle reconnect attempts with retry budget
   */
  private async handleReconnect(error?: unknown): Promise<void> {
    if (!this.shouldReconnect) return;

    if (this.retryCount < this.config.maxRetries) {
      this.retryCount++;
      console.log(
        `[${this.sessionId}] Reconnecting... (Attempt ${this.retryCount}/${this.config.maxRetries})`
      );
      
      await delay(3000); // Wait 3 seconds before reconnecting
      await this.connect();
    } else {
      console.error(
        `[${this.sessionId}] Max retry attempts reached. Stopping session.`
      );
      this.updateStatus('error', error);
      this.emitBoth(WacapEventType.SESSION_ERROR, {
        sessionId: this.sessionId,
        timestamp: new Date(),
        error: new Error('Max retry attempts reached'),
      });
    }
  }

  /**
   * Handle logged out / corrupted creds by resetting auth state
   */
  private async handleLoggedOut(error?: unknown): Promise<void> {
    this.updateStatus('disconnected', error);
    this.retryCount = 0;
    this.resetAuthState();

    if (!this.shouldReconnect) return;

    console.log(`[${this.sessionId}] Session logged out. Resetting auth and waiting for new QR.`);
    this.emitBoth(WacapEventType.SESSION_ERROR, {
      sessionId: this.sessionId,
      timestamp: new Date(),
      error: error || new Error('Logged out'),
    });

    await delay(1000);
    await this.connect();
  }

  /**
   * Wipes existing auth files to force a fresh QR
   */
  private resetAuthState(): void {
    try {
      rmSync(this.sessionPath, { recursive: true, force: true });
      mkdirSync(this.sessionPath, { recursive: true });
    } catch (err) {
      console.error(`[${this.sessionId}] Failed to reset auth state`, err);
    }
  }

  /**
   * Extract message body text
   */
  private getMessageBody(message: proto.IWebMessageInfo): string | undefined {
    const messageContent = message.message;
    if (!messageContent) return undefined;

    return (
      messageContent.conversation ||
      messageContent.extendedTextMessage?.text ||
      messageContent.imageMessage?.caption ||
      messageContent.videoMessage?.caption ||
      messageContent.documentMessage?.caption ||
      undefined
    );
  }

  /**
   * Stop the session
   */
  async stop(): Promise<void> {
    this.shouldReconnect = false;
    this.retryCount = 0;

    if (this.socket) {
      await this.socket.logout();
      this.socket = null;
    }

    this.updateStatus('disconnected');

    this.emitBoth(WacapEventType.SESSION_STOP, {
      sessionId: this.sessionId,
      timestamp: new Date(),
    });
  }

  /**
   * Get session info
   */
  getInfo(): SessionInfo {
    const connectionState = this.socket?.user
      ? { connection: 'open' as const }
      : { connection: 'close' as const };

    return {
      sessionId: this.sessionId,
      status: this.status,
      isActive: !!this.socket,
      connectionState: connectionState as any,
      phoneNumber: this.socket?.user?.id?.split(':')[0],
      userName: this.socket?.user?.name,
      createdAt: this.createdAt,
      lastSeenAt: this.lastSeenAt,
      updatedAt: this.updatedAt,
      error: this.lastError,
    };
  }

  /**
   * Get event manager for registering event handlers
   */
  getEventManager(): EventManager {
    return this.eventManager;
  }

  /**
   * Get the socket instance
   */
  getSocket(): IWASocket | null {
    return this.socket;
  }

  /**
   * Check if session is active
   */
  isActive(): boolean {
    return !!this.socket;
  }

  /**
   * Emit to local event manager and global bus
   */
  private emitBoth(event: WacapEventType, data: any): void {
    this.eventManager.emit(event, data);
    this.globalBus.emit(event, data);
  }
}
