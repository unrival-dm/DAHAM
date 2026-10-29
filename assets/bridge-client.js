(() => {
  'use strict';

  const cfg = window.DAHAM_CONFIG || {};
  const baseUrl = String(cfg.appsScriptUrl || '').trim();
  const timeoutMs = Number(cfg.bridgeTimeoutMs || 60000);

  if (!baseUrl) {
    console.error('[DAHAM] Apps Script URL이 설정되지 않았습니다.');
    return;
  }

  const bridgeUrl =
    baseUrl +
    (baseUrl.includes('?') ? '&' : '?') +
    'page=' + encodeURIComponent(cfg.bridgePage || 'bridge');

  let iframe = null;
  let ready = false;
  let seq = 0;
  const pending = new Map();
  const queue = [];

  function ensureFrame() {
    if (iframe) return;

    iframe = document.createElement('iframe');
    iframe.id = 'dahamApiBridge';
    iframe.src = bridgeUrl;
    iframe.setAttribute('aria-hidden', 'true');
    iframe.setAttribute('tabindex', '-1');
    iframe.style.cssText =
      'position:fixed;width:1px;height:1px;left:-9999px;top:-9999px;' +
      'border:0;opacity:0;pointer-events:none;';

    const mount = () => {
      if (!iframe.isConnected) document.body.appendChild(iframe);
    };

    if (document.body) mount();
    else window.addEventListener('DOMContentLoaded', mount, {once:true});
  }

  function flushQueue() {
    if (!ready || !iframe || !iframe.contentWindow) return;

    while (queue.length) {
      iframe.contentWindow.postMessage(queue.shift(), '*');
    }
  }

  function sendCall(fn, args, success, failure) {
    ensureFrame();

    const id = 'call-' + Date.now() + '-' + (++seq);
    const payload = {
      type: 'DAHAM_BRIDGE_CALL',
      id,
      fn: String(fn),
      args: Array.isArray(args) ? args : []
    };

    const timer = setTimeout(() => {
      const item = pending.get(id);
      if (!item) return;

      pending.delete(id);

      const err = new Error(
        '서버 응답이 지연되고 있습니다. 잠시 후 다시 시도해주세요.'
      );

      if (typeof item.failure === 'function') item.failure(err);
      else console.error(err);
    }, timeoutMs);

    pending.set(id, {success, failure, timer});

    if (ready && iframe && iframe.contentWindow) {
      iframe.contentWindow.postMessage(payload, '*');
    } else {
      queue.push(payload);
    }
  }

  window.addEventListener('message', event => {
    const data = event.data || {};

    if (data.type === 'DAHAM_BRIDGE_READY') {
      ready = true;
      flushQueue();

      window.dispatchEvent(
        new CustomEvent('daham-bridge-ready')
      );
      return;
    }

    if (data.type !== 'DAHAM_BRIDGE_RESULT' || !data.id) return;

    const item = pending.get(data.id);
    if (!item) return;

    clearTimeout(item.timer);
    pending.delete(data.id);

    if (data.ok) {
      if (typeof item.success === 'function') {
        item.success(data.result);
      }
      return;
    }

    const err = new Error(
      data.error && data.error.message
        ? data.error.message
        : '서버 처리 중 오류가 발생했습니다.'
    );

    if (typeof item.failure === 'function') item.failure(err);
    else console.error(err);
  });

  function createRunner() {
    const state = {
      success: null,
      failure: null
    };

    let proxy = null;

    proxy = new Proxy({}, {
      get(_target, prop) {
        if (prop === 'withSuccessHandler') {
          return fn => {
            state.success = fn;
            return proxy;
          };
        }

        if (prop === 'withFailureHandler') {
          return fn => {
            state.failure = fn;
            return proxy;
          };
        }

        if (prop === 'withUserObject') {
          return () => proxy;
        }

        if (prop === 'then') return undefined;

        return (...args) => {
          sendCall(
            String(prop),
            args,
            state.success,
            state.failure
          );
        };
      }
    });

    return proxy;
  }

  if (!window.google) window.google = {};
  if (!window.google.script) window.google.script = {};

  Object.defineProperty(window.google.script, 'run', {
    configurable: true,
    enumerable: true,
    get: createRunner
  });

  ensureFrame();
})();
