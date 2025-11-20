// Main exports
export { WacapWrapper } from './core/wacap-wrapper';
export { Session } from './core/session';

// Event management
export { EventManager } from './events/event-manager';

// Storage adapters
export { SQLiteStorageAdapter, PrismaStorageAdapter } from './storage';

// Types
export * from './types';

// Re-export Baileys types for convenience
export type {
  WASocket,
  proto,
  Contact,
  GroupMetadata,
  WAMessage,
  ConnectionState,
  AnyMessageContent,
  BaileysEventMap,
} from '@whiskeysockets/baileys';
