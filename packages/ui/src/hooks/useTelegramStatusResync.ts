import { useEffect, useRef } from 'react';
import { useConfigStore } from '@/stores/useConfigStore';
import { useMessengerStore } from '@/stores/useMessengerStore';
import { useOpenChamberAgentEventsStore } from '@/stores/useOpenChamberAgentEventsStore';

/**
 * Keep Telegram settings status aligned with the live server listener.
 * The Telegram half of useDiscordStatusResync: re-sync on runtime reconnect
 * and flip to connected as soon as the listener emits `listener_ready`.
 */
export function useTelegramStatusResync() {
  const isConnected = useConfigStore((s) => s.isConnected);
  const lastSyncedConnectedRef = useRef(false);

  useEffect(() => {
    if (!isConnected) {
      lastSyncedConnectedRef.current = false;
      return;
    }
    // Only fire on the rising edge (and the initial connected mount). Avoids
    // re-hitting Telegram on unrelated re-renders while already connected.
    if (lastSyncedConnectedRef.current) return;
    lastSyncedConnectedRef.current = true;
    void useMessengerStore.getState().resyncTelegramStatus();
  }, [isConnected]);

  useEffect(() => {
    return useOpenChamberAgentEventsStore.getState().subscribeToEvents((event) => {
      if (event.eventType !== 'messenger.telegram.listener_ready') return;
      const data =
        event.data && typeof event.data === 'object'
          ? (event.data as { botId?: string; botUsername?: string })
          : null;
      useMessengerStore.getState().updateConnection('telegram', {
        status: 'connected',
        error: null,
        telegramListenerRunning: true,
        telegramListenerConnected: true,
        lastConnectedAt: Date.now(),
        ...(data?.botId ? { telegramBotId: data.botId } : {}),
        ...(data?.botUsername ? { telegramBotUsername: data.botUsername } : {}),
      });
    });
  }, []);
}
