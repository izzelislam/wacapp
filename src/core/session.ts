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
import { existsSync, mkdirSync } from 'fs';
import {
  WacapConfig,
  SessionInfo,
  MessageOptions,
  WacapEventType,
  IStorageAdapter,
  IWASocket,
} from '../types';
import { EventManager } from '../events';

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

  constructor(
    sessionId: string,
    config: WacapConfig,
    storageAdapter: IStorageAdapter
  ) {
    this.sessionId = sessionId;
    this.storageAdapter = storageAdapter;
    this.eventManager = new EventManager(sessionId);
    
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

    this.isConnecting = true;
    this.shouldReconnect = true;
    this.retryCount = 0;

    try {
      await this.connect();
    } catch (error) {
      this.isConnecting = false;
      throw error;
    }
  }

  /**
   * Connect to WhatsApp
   */
  private async connect(): Promise<void> {
    const logger = pino({
      level: this.config.logger.level,
    });

    // Load auth state
    const { state, saveCreds } = await useMultiFileAuthState(this.sessionPath);

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
    this.setupEventHandlers(saveCreds);

    this.isConnecting = false;

    // Emit session start event
    this.eventManager.emit(WacapEventType.SESSION_START, {
      sessionId: this.sessionId,
      timestamp: new Date(),
    });
  }

  /**
   * Setup event handlers for the socket
   */
  private setupEventHandlers(saveCreds: () => Promise<void>): void {
    if (!this.socket) return;

    // Connection updates
    this.socket.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      // Emit connection update event
      this.eventManager.emit(WacapEventType.CONNECTION_UPDATE, {
        sessionId: this.sessionId,
        timestamp: new Date(),
        state: update as any,
        qr,
      });

      // Handle QR code
      if (qr) {
        if (this.config.autoDisplayQR) {
          console.log(`\n[${this.sessionId}] Scan this QR code to login:\n`);
          qrcode.generate(qr, { small: true });
        }

        this.eventManager.emit(WacapEventType.QR_CODE, {
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

        this.eventManager.emit(WacapEventType.CONNECTION_OPEN, {
          sessionId: this.sessionId,
          timestamp: new Date(),
          state: update as any,
        });
      }

      // Handle disconnection
      if (connection === 'close') {
        const shouldReconnect = (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
        
        console.log(
          `[${this.sessionId}] Connection closed. Reconnecting: ${shouldReconnect}`
        );

        this.eventManager.emit(WacapEventType.CONNECTION_CLOSE, {
          sessionId: this.sessionId,
          timestamp: new Date(),
          state: update as any,
          error: lastDisconnect?.error,
        });

        if (shouldReconnect && this.shouldReconnect) {
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
            this.eventManager.emit(WacapEventType.SESSION_ERROR, {
              sessionId: this.sessionId,
              timestamp: new Date(),
              error: new Error('Max retry attempts reached'),
            });
          }
        }
      }
    });

    // Credentials update
    this.socket.ev.on('creds.update', saveCreds);

    // Messages
    this.socket.ev.on('messages.upsert', async ({ messages, type }) => {
      for (const message of messages) {
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
          this.eventManager.emit(WacapEventType.MESSAGE_SENT, eventData);
        } else {
          this.eventManager.emit(WacapEventType.MESSAGE_RECEIVED, eventData);
        }
      }
    });

    // Message updates
    this.socket.ev.on('messages.update', async (updates) => {
      for (const update of updates) {
        this.eventManager.emit(WacapEventType.MESSAGE_UPDATE, {
          sessionId: this.sessionId,
          timestamp: new Date(),
          message: update as any,
        });
      }
    });

    // Message deletes
    this.socket.ev.on('messages.delete', async (item) => {
      this.eventManager.emit(WacapEventType.MESSAGE_DELETE, {
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

      this.eventManager.emit(WacapEventType.CONTACT_UPDATE, {
        sessionId: this.sessionId,
        timestamp: new Date(),
      });
    });

    // Chats
    this.socket.ev.on('chats.upsert', async (chats) => {
      for (const chat of chats) {
        await this.storageAdapter.saveChat(this.sessionId, chat);
      }

      this.eventManager.emit(WacapEventType.CHAT_UPDATE, {
        sessionId: this.sessionId,
        timestamp: new Date(),
      });
    });

    // Groups
    this.socket.ev.on('groups.update', async (updates) => {
      this.eventManager.emit(WacapEventType.GROUP_UPDATE, {
        sessionId: this.sessionId,
        timestamp: new Date(),
      });
    });

    // Group participants
    this.socket.ev.on('group-participants.update', async (update) => {
      this.eventManager.emit(WacapEventType.GROUP_PARTICIPANTS_UPDATE, {
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
      this.eventManager.emit(WacapEventType.PRESENCE_UPDATE, {
        sessionId: this.sessionId,
        timestamp: new Date(),
        jid: update.id,
        presences: update.presences as any,
      });
    });

    // Calls
    this.socket.ev.on('call', async (calls) => {
      this.eventManager.emit(WacapEventType.CALL, {
        sessionId: this.sessionId,
        timestamp: new Date(),
      });
    });
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

    if (this.socket) {
      await this.socket.logout();
      this.socket = null;
    }

    this.eventManager.emit(WacapEventType.SESSION_STOP, {
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
      isActive: !!this.socket,
      connectionState: connectionState as any,
      phoneNumber: this.socket?.user?.id?.split(':')[0],
      userName: this.socket?.user?.name,
      startedAt: undefined, // Could track this
      lastActivityAt: new Date(),
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
}
