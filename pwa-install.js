// ═══════════════════════════════════════════════════════
//  UNIQ  —  PWA Install + Push Subscription Logic
//  Include this in your index.html AFTER Firebase init
// ═══════════════════════════════════════════════════════

// ── YOUR VAPID PUBLIC KEY ──────────────────────────────
// Generate a VAPID key pair at: https://vapidkeys.com
// or run:  npx web-push generate-vapid-keys
// Paste your PUBLIC key here:
const VAPID_PUBLIC_KEY = 'YOUR_VAPID_PUBLIC_KEY_HERE';

// ─────────────────────────────────────────────────────
//  1.  SERVICE WORKER REGISTRATION
// ─────────────────────────────────────────────────────
async function registerSW() {
  if (!('serviceWorker' in navigator)) {
    console.warn('Service Workers not supported');
    return null;
  }
  try {
    const reg = await navigator.serviceWorker.register('./service-worker.js', {
      scope: './'
    });
    console.log('[PWA] Service Worker registered, scope:', reg.scope);
    return reg;
  } catch (err) {
    console.error('[PWA] SW registration failed:', err);
    return null;
  }
}

// ─────────────────────────────────────────────────────
//  2.  PUSH NOTIFICATION SUBSCRIPTION
// ─────────────────────────────────────────────────────
async function subscribeToPush(userId) {
  if (!('PushManager' in window)) {
    console.warn('Push not supported');
    return;
  }

  // Ask for notification permission
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    console.warn('[PWA] Notification permission denied');
    return;
  }

  const reg = await navigator.serviceWorker.ready;

  // Check if already subscribed
  let subscription = await reg.pushManager.getSubscription();
  if (!subscription) {
    subscription = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
    });
  }

  // Save subscription to Firebase (so your server can send pushes)
  if (typeof firebase !== 'undefined' && userId) {
    await firebase.database()
      .ref(`pushSubscriptions/${userId}`)
      .set(JSON.stringify(subscription));
    console.log('[PWA] Push subscription saved to Firebase');
  }

  return subscription;
}

// ─────────────────────────────────────────────────────
//  3.  LISTEN FOR MESSAGES FROM SERVICE WORKER
//      (sound playback, call decline)
// ─────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', event => {
    const msg = event.data;
    if (!msg) return;

    switch (msg.type) {
      case 'PLAY_RINGTONE':
        // Called when a push notification with isCall:true arrives
        playRingtoneSound();
        break;

      case 'PLAY_NOTIFICATION_SOUND':
        // Called for regular message notifications
        playNotificationSound();
        break;

      case 'DECLINE_CALL':
        // User tapped Decline on the notification
        if (typeof rejectIncomingCall === 'function') {
          rejectIncomingCall();
        }
        break;
    }
  });
}

// ─────────────────────────────────────────────────────
//  4.  NOTIFICATION SOUNDS  (Web Audio API)
//      No external .mp3 needed — generated in-browser.
//      To use your own .mp3 ringtone:
//        1. Place ringtone.mp3 in your project root
//        2. Replace playRingtoneSound() with:
//              const audio = new Audio('./ringtone.mp3');
//              audio.loop = true;
//              audio.volume = 1.0;
//              audio.play();
//           And save the reference to stop it later.
// ─────────────────────────────────────────────────────
let _ringtoneCtx = null;
let _ringtoneInterval = null;
let _notifCtx = null;

function playRingtoneSound() {
  stopRingtoneSound(); // stop any existing
  _ringtoneCtx = new (window.AudioContext || window.webkitAudioContext)();

  function ringBeat() {
    if (!_ringtoneCtx) return;
    // Rising double-tone pattern
    [[880, 0, 0.18], [988, 0.2, 0.18], [880, 0.45, 0.18], [988, 0.65, 0.18]].forEach(([freq, delay, dur]) => {
      const osc  = _ringtoneCtx.createOscillator();
      const gain = _ringtoneCtx.createGain();
      osc.connect(gain); gain.connect(_ringtoneCtx.destination);
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, _ringtoneCtx.currentTime + delay);
      gain.gain.linearRampToValueAtTime(0.5, _ringtoneCtx.currentTime + delay + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, _ringtoneCtx.currentTime + delay + dur);
      osc.start(_ringtoneCtx.currentTime + delay);
      osc.stop(_ringtoneCtx.currentTime + delay + dur + 0.02);
    });
    // Vibrate in phone-call pattern
    if ('vibrate' in navigator) navigator.vibrate([300, 150, 300, 150, 300]);
  }

  ringBeat();
  _ringtoneInterval = setInterval(ringBeat, 1500);
}

function stopRingtoneSound() {
  if (_ringtoneInterval)  { clearInterval(_ringtoneInterval); _ringtoneInterval = null; }
  if (_ringtoneCtx)       { _ringtoneCtx.close().catch(() => {}); _ringtoneCtx = null; }
  if ('vibrate' in navigator) navigator.vibrate(0);
}

function playNotificationSound() {
  // Short, subtle "pop" sound for messages
  _notifCtx = new (window.AudioContext || window.webkitAudioContext)();
  const osc  = _notifCtx.createOscillator();
  const gain = _notifCtx.createGain();
  osc.connect(gain); gain.connect(_notifCtx.destination);
  osc.type = 'sine';
  osc.frequency.setValueAtTime(1200, _notifCtx.currentTime);
  osc.frequency.exponentialRampToValueAtTime(800, _notifCtx.currentTime + 0.1);
  gain.gain.setValueAtTime(0.3, _notifCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, _notifCtx.currentTime + 0.15);
  osc.start(_notifCtx.currentTime);
  osc.stop(_notifCtx.currentTime + 0.15);
  if ('vibrate' in navigator) navigator.vibrate([100]);
}

// ─────────────────────────────────────────────────────
//  5.  INSTALL PROMPT  (custom "Add to Home Screen")
// ─────────────────────────────────────────────────────
let _deferredPrompt = null;

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  _deferredPrompt = e;

  // Only show banner if not already installed
  if (window.matchMedia('(display-mode: standalone)').matches) return;

  const banner = document.getElementById('install-banner');
  if (banner) banner.classList.remove('hidden');
});

// Called by your Install button
async function triggerInstall() {
  if (!_deferredPrompt) return;
  _deferredPrompt.prompt();
  const { outcome } = await _deferredPrompt.userChoice;
  console.log('[PWA] Install outcome:', outcome);
  _deferredPrompt = null;

  const banner = document.getElementById('install-banner');
  if (banner) banner.classList.add('hidden');
}

// Hide banner once installed
window.addEventListener('appinstalled', () => {
  _deferredPrompt = null;
  const banner = document.getElementById('install-banner');
  if (banner) banner.classList.add('hidden');
  console.log('[PWA] App installed successfully');
});

// ─────────────────────────────────────────────────────
//  6.  AUTO-INIT on page load
// ─────────────────────────────────────────────────────
window.addEventListener('load', async () => {
  await registerSW();
});

// Call subscribeToPush(userId) after user logs in, e.g.:
//   auth.onAuthStateChanged(user => {
//     if (user) subscribeToPush(user.uid);
//   });

// ─────────────────────────────────────────────────────
//  HELPER — convert VAPID key
// ─────────────────────────────────────────────────────
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw     = atob(base64);
  const output  = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; ++i) output[i] = raw.charCodeAt(i);
  return output;
}
