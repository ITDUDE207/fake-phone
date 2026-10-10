console.log("My App started");

document.getElementById("hi").onclick = async () => {
  try {
    await phone.toast("Hi from My App!");
    console.log("toast shown");
  } catch (e) {
    console.error(e.message);
  }
};
