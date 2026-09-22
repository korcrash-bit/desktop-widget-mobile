(function () {
  'use strict';
  const C = window.Capacitor;
  function plugin(name) {
    if (!C || (!C.androidBridge && C.getPlatform?.() !== 'android')) return null;
    if (C.Plugins?.[name]) return C.Plugins[name];
    if (typeof C.registerPlugin === 'function') return C.registerPlugin(name);
    if (typeof C.nativePromise !== 'function') return null;
    const proxy = new Proxy({}, {
      get: (_, method) => options => C.nativePromise(name, String(method), options || {})
    });
    (C.Plugins ||= {})[name] = proxy;
    return proxy;
  }
  window.NativeBridge = { plugin };
})();
