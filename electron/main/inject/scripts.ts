import type { ColumnType } from '../../../shared/types'

const WAIT_AND_SEND = `
function waitForElement(selector, index, callback, once) {
  if (once === undefined) once = true;
  const existing = document.querySelectorAll(selector)[index];
  if (existing) {
    callback(existing);
    if (once) return;
  }
  const observer = new MutationObserver(() => {
    const element = document.querySelectorAll(selector)[index];
    if (element) {
      callback(element);
      if (once) observer.disconnect();
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}
function fluxSend(type, body) {
  if (window.fluxagram && typeof window.fluxagram.send === 'function') {
    window.fluxagram.send(type, body);
  }
}
`

const HORIZONTAL_SCROLL = `
(() => {
  if (window.__fluxHorizScroll) return;
  window.__fluxHorizScroll = true;
  window.addEventListener('wheel', (e) => {
    const ax = Math.abs(e.deltaX);
    const ay = Math.abs(e.deltaY);
    if (ax < 6 || ax < ay * 1.75) return;
    e.preventDefault();
    fluxSend('scrollHorizontal', e.deltaX);
  }, { passive: false, capture: true });
})();
`

const FIND_USERNAME = `
(function() {
  const RESERVED = new Set([
    'about','accounts','ads','ar','archive','challenge','consent','create','developer',
    'direct','directory','emails','explore','fxcal','graphql','help','legal','linking',
    'lite','locations','nametag','oauth','p','press','privacy','professional_dashboard',
    'qr','reel','reels','safety','saved','session','settings','share','stories','tags',
    'terms','tv','your_activity','login','signup','emailsignup','onetap'
  ]);
  if (window.__fluxUserWatch) return;
  window.__fluxUserWatch = true;
  let sent = false;
  function onAuthWall() {
    return /\\/accounts\\/(?:login|signup|emailsignup|password)|\\/challenge(?:\\/|$)|\\/auth_platform/i.test(location.pathname);
  }
  function extract(href) {
    if (!href) return null;
    try {
      const url = new URL(href, location.origin);
      if (url.origin !== location.origin) return null;
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length !== 1) return null;
      const name = parts[0];
      if (!/^[A-Za-z0-9._]{1,30}$/.test(name)) return null;
      if (name.startsWith('.') || name.endsWith('.') || name.includes('..')) return null;
      if (RESERVED.has(name.toLowerCase())) return null;
      return name;
    } catch (_) {}
    return null;
  }
  function tryDetect() {
    if (sent) return true;
    if (onAuthWall()) return false;
    const profile = document.querySelector("a[aria-label='Profile'], a[aria-label='Perfil']");
    if (profile) {
      const fromProfile = extract(profile.getAttribute('href') || profile.href || '');
      if (fromProfile) {
        sent = true;
        fluxSend('userName', fromProfile);
        return true;
      }
    }
    const anchors = document.querySelectorAll('a[href]');
    const height = window.innerHeight || 800;
    for (const el of anchors) {
      const name = extract(el.getAttribute('href') || '');
      if (!name) continue;
      const rect = el.getBoundingClientRect();
      const avatar = el.querySelector('img, canvas');
      const inLeftNav = rect.left < 280 && rect.width > 0 && rect.height > 0;
      const inBottomBar = rect.width > 0 && rect.top > height * 0.62;
      if ((inLeftNav || inBottomBar) && avatar) {
        sent = true;
        fluxSend('userName', name);
        return true;
      }
    }
    return false;
  }
  if (tryDetect()) return;
  const obs = new MutationObserver(() => {
    if (tryDetect()) obs.disconnect();
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });
  let ticks = 0;
  const timer = setInterval(() => {
    if (tryDetect() || ++ticks > 120) {
      clearInterval(timer);
      obs.disconnect();
    }
  }, 1000);
})();
`

function wrapOnLoad(body: string): string {
  return `(function() {
  const run = () => {
${body}
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run, { once: true });
  } else {
    run();
  }
})();`
}

export function columnOnLoad(_type: ColumnType): string {
  return wrapOnLoad(WAIT_AND_SEND + HORIZONTAL_SCROLL)
}

/** Clicks Instagram's desktop Create control. Never assigns /create/select/ (mobile treats that as a username). */
export function clickDesktopCreate(): string {
  return `(() => {
  if (window.__fluxDesktopCreate) return;
  window.__fluxDesktopCreate = true;
  const EXACT = /^(new post|nueva publicaci[oó]n|create|crear)$/i;
  function isCreateHref(href) {
    if (!href) return false;
    try {
      const path = new URL(href, location.origin).pathname;
      return /^\\/create(?:\\/|$)/i.test(path);
    } catch (e) {
      return /^\\/create(?:\\/|$)/i.test(href);
    }
  }
  function clickCreate() {
    const nodes = document.querySelectorAll('[aria-label], button, [role="button"], [role="link"], a');
    for (const el of nodes) {
      const anchor = el.closest('a');
      if (anchor && isCreateHref(anchor.getAttribute('href') || '')) continue;
      const label = (el.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim();
      const text = (el.textContent || '').replace(/\\s+/g, ' ').trim();
      const value = EXACT.test(label) ? label : (text.length > 0 && text.length < 28 && EXACT.test(text) ? text : '');
      if (!value) continue;
      const target = el.closest('button, [role="button"], [role="link"], a') || el;
      if (anchor && isCreateHref(anchor.getAttribute('href') || '')) continue;
      if (typeof target.click === 'function') {
        target.click();
        return true;
      }
    }
    return false;
  }
  let ticks = 0;
  const timer = setInterval(() => {
    if (document.querySelector('[role="dialog"]')) {
      clearInterval(timer);
      return;
    }
    clickCreate();
    if (++ticks > 24) clearInterval(timer);
  }, 400);
})();`
}

export function loginOnLoad(): string {
  return wrapOnLoad(WAIT_AND_SEND + FIND_USERNAME)
}

export function detectUserNameOnce(): string {
  return (
    WAIT_AND_SEND +
    `(function() {
  if (typeof fluxSend !== 'function') return;
  if (/\\/accounts\\/(?:login|signup|emailsignup|password)|\\/challenge(?:\\/|$)/i.test(location.pathname)) return;
  const RESERVED = new Set([
    'about','accounts','direct','explore','reels','stories','p','reel','tv','create',
    'challenge','login','signup','legal','privacy','help','nametag','locations','tags'
  ]);
  function extract(href) {
    try {
      const parts = new URL(href, location.origin).pathname.split('/').filter(Boolean);
      if (parts.length !== 1) return null;
      const name = parts[0];
      if (!/^[A-Za-z0-9._]{1,30}$/.test(name) || RESERVED.has(name.toLowerCase())) return null;
      return name;
    } catch (_) {}
    return null;
  }
  const profile = document.querySelector("a[aria-label='Profile'], a[aria-label='Perfil']");
  if (profile) {
    const name = extract(profile.getAttribute('href') || profile.href || '');
    if (name) { fluxSend('userName', name); return; }
  }
  const height = window.innerHeight || 800;
  for (const el of document.querySelectorAll('a[href]')) {
    const name = extract(el.getAttribute('href') || '');
    if (!name || !el.querySelector('img, canvas')) continue;
    const rect = el.getBoundingClientRect();
    const inLeftNav = rect.left < 280 && rect.width > 0 && rect.height > 0;
    if (inLeftNav || (rect.top > height * 0.62 && rect.width > 0)) {
      fluxSend('userName', name);
      return;
    }
  }
})();`
  )
}
