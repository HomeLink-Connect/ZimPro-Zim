/* ZimPro-Linkup — background push service worker.
   Must sit in the SAME folder as index.html (site root). */
importScripts("https://www.gstatic.com/firebasejs/12.1.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/12.1.0/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyA7okyR40IeNWJjH5h0cbQF8yYR_5QHi3w",
  authDomain: "zimpro-linkup.firebaseapp.com",
  projectId: "zimpro-linkup",
  storageBucket: "zimpro-linkup.firebasestorage.app",
  messagingSenderId: "794726149912",
  appId: "1:794726149912:web:90814952c75a3fa278786d"
});

const messaging = firebase.messaging();
const ICON = "icons/zpl-192.png";

/* The push server sends DATA-ONLY messages, so we build the notification here.
   Tags match the ones index.html uses (msg_<convId> / call_<callId>) so you never get duplicates. */
messaging.onBackgroundMessage((payload) => {
  const d = payload.data || {};
  const isCall = d.kind === "call";

  const title = d.title || (isCall ? "Incoming ZimPro call" : "New message");
  const options = {
    body: d.body || "",
    icon: ICON,
    badge: ICON,
    tag: isCall ? "call_" + d.callId : "msg_" + (d.convId || d.uid || "x"),
    renotify: true,
    data: d,
  };

  if (isCall) {
    options.requireInteraction = true;
    options.vibrate = [300, 150, 300, 150, 300];
    options.actions = [
      { action: "answer", title: "Answer" },
      { action: "decline", title: "Decline" },
    ];
  }

  // Number on the app icon (installed app): Android / Windows / macOS / iOS home-screen app
  const n = parseInt(d.badge, 10);
  if (!isNaN(n) && self.navigator && "setAppBadge" in self.navigator) {
    (n > 0 ? self.navigator.setAppBadge(n) : self.navigator.clearAppBadge()).catch(() => {});
  }

  return self.registration.showNotification(title, options);
});

/* Tap on a notification (or one of its buttons) */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const d = event.notification.data || {};
  const msg = {
    type: "zpl-open",
    kind: d.kind,
    uid: d.uid,
    name: d.name,
    photo: d.photo,
    callId: d.callId,
    action: event.action || "",
  };

  event.waitUntil(
    (async () => {
      const all = await clients.matchAll({ type: "window", includeUncontrolled: true });
      // App already open somewhere: focus it and hand over the details
      for (const c of all) {
        if ("focus" in c) {
          await c.focus();
          c.postMessage(msg);
          return;
        }
      }
      // App closed: open it with the details in the URL (index.html reads these on launch)
      const q = new URLSearchParams({ from: "push", open: d.kind || "", uid: d.uid || "", name: d.name || "", callId: d.callId || "", act: event.action || "" });
      await clients.openWindow("./?" + q.toString());
    })()
  );
});

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(clients.claim()));
