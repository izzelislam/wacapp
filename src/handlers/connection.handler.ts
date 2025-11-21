import { DisconnectReason } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import { WacapEventType } from '../types';
import { HandlerContext } from './index';

export function registerConnectionHandlers(
  ctx: HandlerContext,
  persistCreds: () => Promise<void>
): void {
  const {
    socket,
    config,
    sessionId,
    emit,
    touchActivity,
    updateStatus,
    handleReconnect,
    handleLoggedOut,
    resetRetry,
    setSocket,
  } = ctx;

  socket.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    emit(WacapEventType.CONNECTION_UPDATE, {
      state: update as any,
      qr,
    });

    if (qr) {
      updateStatus('qr');
      if (config.autoDisplayQR) {
        console.log(`\n[${sessionId}] Scan this QR code to login:\n`);
        qrcode.generate(qr, { small: true });
      }

      emit(WacapEventType.QR_CODE, {
        state: update as any,
        qr,
      });
    }

    if (connection === 'open') {
      console.log(`[${sessionId}] Connection opened successfully`);
      resetRetry();
      updateStatus('connected');
      touchActivity();

      emit(WacapEventType.CONNECTION_OPEN, {
        state: update as any,
      });
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      setSocket(null);
      updateStatus(isLoggedOut ? 'disconnected' : 'connecting', lastDisconnect?.error);

      console.log(`[${sessionId}] Connection closed. Reconnecting: ${shouldReconnect}`);

      emit(WacapEventType.CONNECTION_CLOSE, {
        state: update as any,
        error: lastDisconnect?.error,
      });

      if (isLoggedOut) {
        await handleLoggedOut(lastDisconnect?.error);
        return;
      }

      if (shouldReconnect) {
        await handleReconnect(lastDisconnect?.error);
      }
    }
  });

  socket.ev.on('creds.update', persistCreds);
}
