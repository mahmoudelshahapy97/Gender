import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { notifications as notificationsApi } from "../api/endpoints";
import { useAuth } from "../auth/AuthContext";
import { useToast } from "../components/Toast";

const NotificationsContext = createContext(null);

/** How many the bell's menu shows. */
const RECENT = 8;

const TOAST_SEVERITY = { critical: "error", warning: "warning", info: "success" };

/**
 * The unread count and the latest notifications, kept current by one
 * Server-Sent Events stream (GET /notifications/stream) for the whole console.
 *
 * The stream is cookie-authenticated and ends when the access token does. The
 * browser reconnects on its own; if that reconnect is refused (the cookie
 * expired with the token), an ordinary authenticated call lets the axios
 * client refresh the session -- which renews the cookie -- and the stream is
 * reopened, with backoff. `version` bumps on every live notification, so a
 * page listing them can reload.
 */
export function NotificationsProvider({ children }) {
  const { user } = useAuth();
  const toast = useToast();
  const [recent, setRecent] = useState(null);
  const [unread, setUnread] = useState(0);
  const [live, setLive] = useState(false);
  const [version, setVersion] = useState(0);
  const toastRef = useRef(toast);
  toastRef.current = toast;

  const reload = useCallback(async () => {
    const page = await notificationsApi.list({ limit: RECENT });
    setRecent(page.items);
    setUnread(page.unread);
    return page;
  }, []);

  useEffect(() => {
    if (!user) return undefined;
    let source = null;
    let retryTimer = null;
    let stopped = false;
    let attempt = 0;
    let connectedBefore = false;

    reload().catch(() => {});

    const connect = () => {
      source = new EventSource(notificationsApi.streamUrl(), { withCredentials: true });
      source.addEventListener("ready", (event) => {
        attempt = 0;
        setLive(true);
        setUnread(JSON.parse(event.data).unread);
        // A reconnect: whatever happened while the stream was down is missing.
        if (connectedBefore) {
          reload().catch(() => {});
          setVersion((v) => v + 1);
        }
        connectedBefore = true;
      });
      source.addEventListener("notification", (event) => {
        const item = JSON.parse(event.data);
        setRecent((current) =>
          [item, ...(current || []).filter((n) => n.notification_id !== item.notification_id)].slice(
            0,
            RECENT
          )
        );
        setUnread((count) => count + 1);
        setVersion((v) => v + 1);
        toastRef.current(item.title, TOAST_SEVERITY[item.severity] || "info");
      });
      // This stream fell behind and dropped some: reload rather than guess.
      source.addEventListener("resync", () => {
        reload().catch(() => {});
        setVersion((v) => v + 1);
      });
      source.onerror = () => {
        setLive(false);
        // CONNECTING means the browser is already retrying by itself. CLOSED
        // means the server refused (401 with a stale cookie, 503 when full).
        if (source.readyState !== EventSource.CLOSED) return;
        source.close();
        attempt += 1;
        retryTimer = setTimeout(async () => {
          try {
            await reload();
          } catch {
            /* still down: try again after the next backoff */
          }
          if (!stopped) connect();
        }, Math.min(60000, 1000 * 2 ** attempt));
      };
    };
    connect();

    return () => {
      stopped = true;
      clearTimeout(retryTimer);
      source?.close();
      setLive(false);
    };
  }, [user, reload]);

  const markRead = useCallback(async (id) => {
    setRecent((current) =>
      (current || []).map((n) => (n.notification_id === id ? { ...n, is_read: true } : n))
    );
    const result = await notificationsApi.markRead(id);
    setUnread(result.unread);
    return result;
  }, []);

  const markUnread = useCallback(async (id) => {
    setRecent((current) =>
      (current || []).map((n) => (n.notification_id === id ? { ...n, is_read: false } : n))
    );
    const result = await notificationsApi.markUnread(id);
    setUnread(result.unread);
    return result;
  }, []);

  const markAllRead = useCallback(async () => {
    const result = await notificationsApi.markAllRead();
    setRecent((current) => (current || []).map((n) => ({ ...n, is_read: true })));
    setUnread(result.unread);
    return result;
  }, []);

  const value = useMemo(
    () => ({ recent, unread, live, version, reload, markRead, markUnread, markAllRead }),
    [recent, unread, live, version, reload, markRead, markUnread, markAllRead]
  );
  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
}

export function useNotifications() {
  const ctx = useContext(NotificationsContext);
  if (!ctx) throw new Error("useNotifications must be used within a NotificationsProvider");
  return ctx;
}

export default NotificationsContext;
