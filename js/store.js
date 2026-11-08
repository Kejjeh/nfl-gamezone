// localStorage with TTL. Every access is wrapped: quota errors, private-mode
// throws and corrupt JSON must never take the app down.
import { LS_PREFIX } from './config.js';

export function get(key) {
  try {
    const raw = localStorage.getItem(LS_PREFIX + key);
    if (!raw) return null;
    const rec = JSON.parse(raw);
    if (rec && rec.exp && Date.now() > rec.exp) {
      localStorage.removeItem(LS_PREFIX + key);
      return null;
    }
    return rec ? rec.v : null;
  } catch (e) {
    console.warn('[store] read failed', key, e);
    return null;
  }
}

export function set(key, v, ttl) {
  try {
    const rec = { v, exp: ttl ? Date.now() + ttl : 0 };
    localStorage.setItem(LS_PREFIX + key, JSON.stringify(rec));
    return true;
  } catch (e) {
    console.warn('[store] write failed (quota?)', key, e);
    return false;
  }
}

export function del(key) {
  try { localStorage.removeItem(LS_PREFIX + key); } catch (e) { /* ignore */ }
}
