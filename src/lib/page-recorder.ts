// Script injected into the observed page. It only listens (capture phase, passive
// listeners) and reports user actions through a CDP binding. Typed values are never
// reported, only their input type and length.

export const ACTION_BINDING = '__speculaAction';

export const PAGE_RECORDER_SOURCE = `(() => {
  if (window.__speculaRecorder) return;
  window.__speculaRecorder = true;
  const send = (payload) => {
    try { window.${ACTION_BINDING}(JSON.stringify(payload)); } catch (_) {}
  };
  const INTERACTIVE = 'a,button,input,select,textarea,label,summary,[role=button],[role=link],[role=menuitem],[role=checkbox],[role=switch],[role=tab],[role=option],[role=treeitem],[contenteditable=""],[contenteditable=true],[onclick],[tabindex]';
  const IMPLICIT_ROLES = { A: 'link', BUTTON: 'button', SELECT: 'combobox', TEXTAREA: 'textbox', SUMMARY: 'button', OPTION: 'option', LI: 'listitem', H1: 'heading', H2: 'heading', H3: 'heading', NAV: 'navigation', FORM: 'form', IMG: 'img', LABEL: 'label' };
  const INPUT_ROLES = { checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button', reset: 'button', search: 'searchbox', range: 'slider' };
  const clip = (s, n) => { s = (s || '').replace(/\\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
  const roleOf = (el) => el.getAttribute('role') || (el.tagName === 'INPUT' ? (INPUT_ROLES[el.type] || 'textbox') : IMPLICIT_ROLES[el.tagName]) || undefined;
  const nameOf = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria) return clip(aria, 60);
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy.split(/\\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ');
      if (text.trim()) return clip(text, 60);
    }
    if (el.labels && el.labels.length) return clip(el.labels[0].textContent, 60);
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return clip(el.getAttribute('placeholder') || el.getAttribute('name') || '', 60);
    return clip(el.innerText || el.getAttribute('title') || el.getAttribute('alt') || '', 60);
  };
  const cssPath = (el) => {
    const parts = [];
    for (let node = el; node && node.nodeType === 1 && parts.length < 5; node = node.parentElement) {
      if (node.id && !/\\d{3,}/.test(node.id)) { parts.unshift('#' + CSS.escape(node.id)); break; }
      const testId = node.getAttribute('data-testid') || node.getAttribute('data-cy');
      if (testId) { parts.unshift('[data-testid="' + testId + '"]'); break; }
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
    }
    return parts.join(' > ');
  };
  const describe = (el) => {
    const out = { tag: el.tagName.toLowerCase(), selector: cssPath(el) };
    const role = roleOf(el); if (role) out.role = role;
    const name = nameOf(el); if (name) out.name = name;
    if (el.id) out.id = el.id;
    const testId = el.getAttribute('data-testid') || el.getAttribute('data-cy'); if (testId) out.testId = testId;
    if (el.type && typeof el.type === 'string') out.type = el.type;
    if (el.tagName === 'A' && el.getAttribute('href')) out.href = el.getAttribute('href');
    return out;
  };
  const targetOf = (event) => {
    const el = event.composedPath ? event.composedPath()[0] : event.target;
    if (!(el instanceof Element)) return null;
    return el.closest(INTERACTIVE) || el;
  };
  const report = (kind, el, extra) => {
    if (!el) return;
    send(Object.assign({ kind, t: Date.now(), target: describe(el), url: location.href }, extra || {}));
  };
  document.addEventListener('click', (e) => report('click', targetOf(e)), { capture: true, passive: true });
  document.addEventListener('submit', (e) => report('submit', targetOf(e)), { capture: true, passive: true });
  document.addEventListener('change', (e) => {
    const el = targetOf(e);
    if (el && (el.type === 'checkbox' || el.type === 'radio' || el.tagName === 'SELECT')) report('change', el, { valueInfo: { type: el.type || 'select', length: el.type === 'checkbox' ? Number(el.checked) : String(el.value || '').length } });
  }, { capture: true, passive: true });
  const pendingInput = new Map();
  document.addEventListener('input', (e) => {
    const el = targetOf(e);
    if (!el || el.type === 'checkbox' || el.type === 'radio' || el.tagName === 'SELECT') return;
    clearTimeout(pendingInput.get(el));
    pendingInput.set(el, setTimeout(() => {
      pendingInput.delete(el);
      const value = el.isContentEditable ? el.innerText : el.value;
      report('input', el, { valueInfo: { type: el.type || (el.isContentEditable ? 'contenteditable' : el.tagName.toLowerCase()), length: String(value || '').length } });
    }, 400));
  }, { capture: true, passive: true });
  document.addEventListener('keydown', (e) => {
    const special = ['Enter', 'Escape', 'Tab', 'Delete', 'Backspace'].includes(e.key);
    if (!special && !e.ctrlKey && !e.metaKey && !e.altKey) return;
    if (e.key === 'Backspace' && !e.ctrlKey && !e.metaKey) return;
    const combo = [e.ctrlKey && 'Control', e.metaKey && 'Meta', e.altKey && 'Alt', e.shiftKey && special && 'Shift', e.key].filter(Boolean).join('+');
    report('key', targetOf(e) || document.activeElement, { key: combo });
  }, { capture: true, passive: true });
})();`;

// Reads framework and runtime markers without changing the page.
export const RUNTIME_PROBE_SOURCE = `(() => {
  const STANDARD = new Set(['window','self','document','name','location','customElements','history','navigation','locationbar','menubar','personalbar','scrollbars','statusbar','toolbar','status','closed','frames','length','top','opener','parent','frameElement','navigator','origin','external','screen','innerWidth','innerHeight','scrollX','pageXOffset','scrollY','pageYOffset','visualViewport','screenX','screenY','outerWidth','outerHeight','devicePixelRatio','event','clientInformation','screenLeft','screenTop','styleMedia','isSecureContext','crossOriginIsolated','performance','indexedDB','sessionStorage','localStorage','crypto','caches','cookieStore','scheduler','trustedTypes','speechSynthesis','launchQueue','documentPictureInPicture','sharedStorage','fence','credentialless','onsearchresult','chrome','__speculaRecorder','__speculaAction']);
  const globals = Object.keys(window).filter((k) => !STANDARD.has(k) && !k.startsWith('on') && !k.startsWith('webkit')).slice(0, 200);
  const has = (sel) => { try { return !!document.querySelector(sel); } catch (_) { return false; } };
  const anyAttrPrefix = (prefix) => { for (const el of document.querySelectorAll('*')) { for (const a of el.attributes) if (a.name.startsWith(prefix)) return true; } return false; };
  const meta = {};
  for (const m of document.querySelectorAll('meta[name],meta[property]')) {
    const key = m.getAttribute('name') || m.getAttribute('property');
    if (/^(generator|application-name|theme-color|viewport|framework|next-head-count)$/i.test(key)) meta[key] = (m.getAttribute('content') || '').slice(0, 120);
  }
  const root = document.getElementById('app') || document.getElementById('root') || document.getElementById('__next') || document.body.firstElementChild;
  return {
    url: location.href,
    title: document.title ? '[present]' : '',
    globals,
    markers: {
      vue: !!(window.__VUE__ || (root && root.__vue_app__) || anyAttrPrefix('data-v-')),
      vueVersion: root && root.__vue_app__ ? root.__vue_app__.version : undefined,
      react: !!(window.React || has('[data-reactroot]') || (root && Object.keys(root).some((k) => k.startsWith('__reactContainer') || k.startsWith('_reactRoot')))),
      next: !!(window.__NEXT_DATA__ || window.next || has('#__next')),
      nuxt: !!(window.__NUXT__ || window.$nuxt),
      angular: has('[ng-version]'),
      angularVersion: document.querySelector('[ng-version]')?.getAttribute('ng-version') || undefined,
      svelte: Array.from(document.querySelectorAll('[class]')).some((el) => /\\bsvelte-/.test(el.className)),
      remix: !!window.__remixContext,
      ember: !!(window.Ember || has('.ember-view') || has('.ember-application')),
      serviceWorker: !!(navigator.serviceWorker && navigator.serviceWorker.controller),
      moduleScripts: document.querySelectorAll('script[type=module]').length,
    },
    meta,
    storageKeys: { local: Object.keys(localStorage).slice(0, 50), session: Object.keys(sessionStorage).slice(0, 50) },
    rootId: root ? root.id || root.tagName.toLowerCase() : undefined,
  };
})()`;
