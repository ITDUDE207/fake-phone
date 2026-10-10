// FakePhone SDK. The phone injects this into every folder-installed app, so apps just use
// `window.phone`. Apps loaded from a dev server (devUrl) include it themselves:
//   a script tag with src="phone-sdk.js"
// It talks to the phone over postMessage; the phone checks permissions on its side.
(function () {
  if (window.phone && window.phone.version) return; // already injected
  var next = 0;
  var pending = {};
  function send(msg) {
    try { parent.postMessage(msg, "*"); } catch (e) { /* not in a phone */ }
  }
  window.addEventListener("message", function (e) {
    var m = e.data;
    if (!m || m.fp !== 1 || !pending[m.id]) return;
    var p = pending[m.id];
    delete pending[m.id];
    if (m.ok) p.resolve(m.result);
    else p.reject(new Error(m.error || "Request failed"));
  });
  function call(method, params) {
    return new Promise(function (resolve, reject) {
      var id = ++next;
      pending[id] = { resolve: resolve, reject: reject };
      send({ fp: 1, id: id, method: method, params: params || {} });
    });
  }

  // Forward console output and errors so the phone's Developer mode console can show them.
  function fmt(a) {
    if (a instanceof Error) return a.stack || a.message;
    if (typeof a === "string") return a;
    try { return String(JSON.stringify(a)); } catch (e) { return String(a); }
  }
  ["log", "info", "warn", "error"].forEach(function (level) {
    var orig = console[level];
    console[level] = function () {
      try { send({ fp: 1, log: level, text: Array.prototype.map.call(arguments, fmt).join(" ") }); } catch (e) { /* ignore */ }
      return orig.apply(console, arguments);
    };
  });
  window.addEventListener("error", function (e) {
    send({ fp: 1, log: "error", text: (e.message || "Error") + (e.filename ? " (" + e.filename.split("/").pop() + ":" + e.lineno + ")" : "") });
  });
  window.addEventListener("unhandledrejection", function (e) {
    send({ fp: 1, log: "error", text: "Unhandled rejection: " + fmt(e.reason) });
  });

  window.phone = Object.freeze({
    version: 1,
    // permission: "toast"
    toast: function (text) { return call("toast", { text: String(text) }); },
    // permission: "storage" (your app's private folder only)
    fs: Object.freeze({
      read: function (path) { return call("fs.read", { path: path }); },
      write: function (path, text) { return call("fs.write", { path: path, data: text }); },
      list: function (path) { return call("fs.list", { path: path || "" }); },
      remove: function (path) { return call("fs.remove", { path: path }); },
    }),
    // permission: "identity"
    identity: Object.freeze({
      number: function () { return call("identity.number"); },
      theme: function () { return call("identity.theme"); },
    }),
    // permission: "messages.send"
    messages: Object.freeze({
      send: function (to, text) { return call("messages.send", { to: to, text: text }); },
    }),
  });
  call("sdk.hello").catch(function () { /* older phones don't know it */ });
})();
