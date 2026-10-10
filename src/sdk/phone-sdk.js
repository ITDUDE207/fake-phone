// FakePhone SDK. The phone injects this into every app, so apps just use `window.phone`.
// It talks to the phone over postMessage; the phone checks permissions on its side.
(function () {
  var next = 0;
  var pending = {};
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
      parent.postMessage({ fp: 1, id: id, method: method, params: params || {} }, "*");
    });
  }
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
})();
