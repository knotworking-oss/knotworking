// The bundled connect page: asks for the server address once, then hands off
// to the Rust `connect` command, which saves it and navigates the window there.
const { invoke } = window.__TAURI__.core;

const form = document.getElementById("connect");
const input = document.getElementById("server");
const error = document.getElementById("error");
const status = document.getElementById("status");
const button = form.querySelector("button");

function showForm(value, message) {
  status.hidden = true;
  form.hidden = false;
  if (value) input.value = value;
  error.textContent = message ?? "";
  error.hidden = !message;
  button.disabled = false;
  input.focus();
  input.select();
}

// `remember` saves the address for next launch; an address from
// KNOTWORKING_SERVER_URL is opened without saving it.
async function open(url, remember) {
  try {
    await invoke("connect", { url, remember });
  } catch (message) {
    showForm(url, String(message));
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  button.disabled = true;
  void open(input.value, true);
});

async function start() {
  const changing = new URLSearchParams(location.search).has("change");
  const saved = await invoke("saved_server").catch(() => ({ url: null, temporary: false }));
  if (saved.url && !changing) {
    status.textContent = `Connecting to ${saved.url}…`;
    status.hidden = false;
    await open(saved.url, !saved.temporary);
  } else {
    showForm(saved.url);
  }
}

void start();
