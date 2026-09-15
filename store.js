// Storage layer: the app reads and writes data only through these functions.
// Now — Telegram CloudStorage (private to the user, per bot), localStorage outside Telegram.
// Later — calls to the Apps Script API from tech-spec; the screens stay the same.

const PREFIX = 'qlub_';
const tg = window.Telegram?.WebApp;
const cloud = tg?.isVersionAtLeast?.('6.9') ? tg.CloudStorage : null;

function cloudCall(method, ...args) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`CloudStorage.${method} timeout`)), 10000);
    cloud[method](...args, (err, result) => {
      clearTimeout(timer);
      if (err) reject(new Error(String(err)));
      else resolve(result);
    });
  });
}

async function getItem(key) {
  if (cloud) return (await cloudCall('getItem', key)) || null;
  return localStorage.getItem(PREFIX + key);
}

async function setItem(key, value) {
  if (cloud) return cloudCall('setItem', key, value);
  localStorage.setItem(PREFIX + key, value);
}

async function getByPrefix(prefix) {
  if (cloud) {
    const keys = (await cloudCall('getKeys')).filter((k) => k.startsWith(prefix));
    if (!keys.length) return [];
    const values = await cloudCall('getItems', keys);
    return keys.map((k) => values[k]).filter(Boolean);
  }
  const values = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key.startsWith(PREFIX + prefix)) values.push(localStorage.getItem(key));
  }
  return values;
}

function parse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function loadProfile() {
  return parse(await getItem('profile'));
}

export function saveProfile(profile) {
  return setItem('profile', JSON.stringify(profile));
}

// Newest first. Each subscription is a separate key: CloudStorage allows 4 096 chars per value.
export async function loadSubscriptions() {
  return (await getByPrefix('sub_'))
    .map(parse)
    .filter(Boolean)
    .sort((a, b) => b.bought.localeCompare(a.bought) || b.id.localeCompare(a.id));
}

export function saveSubscription(sub) {
  return setItem('sub_' + sub.id, JSON.stringify(sub));
}

// Events attended without a subscription. Newest first.
export async function loadEvents() {
  return (await getByPrefix('ev_'))
    .map(parse)
    .filter(Boolean)
    .sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
}

export function saveEvent(event) {
  return setItem('ev_' + event.id, JSON.stringify(event));
}
