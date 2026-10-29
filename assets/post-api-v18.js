(() => {
  'use strict';

  const cfg = window.DAHAM_CONFIG || {};
  const endpoint = String(cfg.appsScriptUrl || '').trim();
  const timeoutMs = Number(cfg.bridgeTimeoutMs || 45000);

  let seq = 0;
  let connected = false;
  const pending = new Map();

  function emit(name, detail) {
    window.dispatchEvent(
      new CustomEvent(name, {detail: detail || {}})
    );
  }

  function cleanup(id) {
    const item = pending.get(id);
    if (!item) return;

    clearTimeout(item.timer);

    if (item.form && item.form.remove) item.form.remove();
    if (item.iframe && item.iframe.remove) {
      // 응답 스크립트가 끝난 다음 제거되도록 한 틱 늦춘다.
      setTimeout(() => item.iframe.remove(), 0);
    }

    pending.delete(id);
  }

  function callServer(fn, args, success, failure) {
    if (!endpoint) {
      const err = new Error('Apps Script API 주소가 설정되지 않았습니다.');
      if (typeof failure === 'function') failure(err);
      else console.error(err);
      return;
    }

    const id = 'req-' + Date.now() + '-' + (++seq);
    const frameName = 'dahamPostFrame_' + id.replace(/[^a-zA-Z0-9_-]/g, '');

    const iframe = document.createElement('iframe');
    iframe.name = frameName;
    iframe.id = frameName;
    iframe.setAttribute('aria-hidden', 'true');
    iframe.setAttribute('tabindex', '-1');
    iframe.style.cssText =
      'position:fixed;width:2px;height:2px;left:-9999px;top:-9999px;' +
      'border:0;opacity:.01;pointer-events:none;';

    const form = document.createElement('form');
    form.method = 'POST';
    form.action = endpoint;
    form.target = frameName;
    form.style.display = 'none';
    form.acceptCharset = 'UTF-8';

    const fields = {
      request_id: id,
      fn: String(fn),
      origin: window.location.origin,
      payload: JSON.stringify(Array.isArray(args) ? args : [])
    };

    Object.keys(fields).forEach(name => {
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = name;
      input.value = fields[name];
      form.appendChild(input);
    });

    const timer = setTimeout(() => {
      const item = pending.get(id);
      if (!item) return;

      cleanup(id);

      const err = new Error(
        '서버 응답이 지연되고 있습니다. 네트워크 상태를 확인한 뒤 다시 시도해주세요.'
      );

      if (typeof item.failure === 'function') item.failure(err);
      else console.error(err);

      emit('daham-bridge-error', {message:err.message});
    }, timeoutMs);

    pending.set(id, {
      success,
      failure,
      iframe,
      form,
      timer,
      fn
    });

    document.body.appendChild(iframe);
    document.body.appendChild(form);
    form.submit();
  }

  window.addEventListener('message', event => {
    // Apps Script 응답은 Google 도메인 iframe에서 top.postMessage로 들어온다.
    const data = event.data || {};

    if (data.type !== 'DAHAM_POST_API_RESULT' || !data.id) return;

    const item = pending.get(data.id);
    if (!item) return;

    const success = item.success;
    const failure = item.failure;
    const wasPing = item.fn === 'ping';

    cleanup(data.id);

    if (data.ok) {
      if (wasPing && !connected) {
        connected = true;
        emit('daham-bridge-ready', {
          version:'18',
          transport:'POST'
        });
      }

      if (typeof success === 'function') success(data.result);
      return;
    }

    const err = new Error(
      data.error && data.error.message
        ? data.error.message
        : '서버 처리 중 오류가 발생했습니다.'
    );

    if (typeof failure === 'function') failure(err);
    else console.error(err);
  });

  function createRunner() {
    const state = {
      success:null,
      failure:null
    };

    let proxy;

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
          callServer(
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
    configurable:true,
    enumerable:true,
    get:createRunner
  });

  window.DAHAM_BRIDGE = {
    get ready(){ return connected; },
    transport:'POST-v18.1',
    ping(){
      callServer('ping', [], () => {}, () => {});
    }
  };

  // body가 준비된 뒤 실제 POST ping으로 서버 연결을 확인한다.
  const start = () => {
    callServer(
      'ping',
      [],
      () => {},
      err => {
        emit('daham-bridge-error', {
          message:
            (err && err.message)
              ? err.message
              : '서버 연결 실패'
        });
      }
    );
  };

  if (document.body) start();
  else window.addEventListener('DOMContentLoaded', start, {once:true});
})();
