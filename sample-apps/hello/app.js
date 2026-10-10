const $ = (id) => document.getElementById(id);
const log = (msg, bad) => {
  const d = document.createElement("div");
  d.textContent = msg;
  if (bad) d.className = "bad";
  $("out").prepend(d);
};
// Every phone call returns a promise and may reject (denied permission, bad path, ...).
const on = (id, fn) => ($(id).onclick = async () => {
  try { log(await fn()); } catch (e) { log(e.message, true); }
});

on("toast", async () => { await phone.toast("Hello from a sandboxed app!"); return "Toast shown"; });
on("number", async () => `Your number is ${await phone.identity.number()} (theme: ${await phone.identity.theme()})`);
on("save", async () => { await phone.fs.write("note.txt", $("note").value); return "Saved note.txt"; });
on("load", async () => { $("note").value = await phone.fs.read("note.txt"); return "Loaded note.txt"; });
on("list", async () => {
  const files = await phone.fs.list();
  return files.length ? files.map((f) => f.name).join(", ") : "No files yet";
});
on("send", async () => { await phone.messages.send($("to").value.replace(/\D/g, ""), "hi"); return "Message sent"; });
