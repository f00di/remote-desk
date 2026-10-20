// Theme toggle: light or dark, remembered on this device. With nothing
// saved, the page follows the system setting.
(function () {
  var root = document.documentElement;
  var btn = document.getElementById("theme-toggle");
  if (!btn) return;
  function current() {
    if (root.dataset.theme) return root.dataset.theme;
    return window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  function label() {
    var next = current() === "dark" ? "light" : "dark";
    btn.setAttribute("aria-label", "Switch to " + next + " theme");
  }
  // Make the icons match the system theme too.
  if (!root.dataset.theme) root.dataset.theme = current();
  label();
  btn.addEventListener("click", function () {
    var next = current() === "dark" ? "light" : "dark";
    root.dataset.theme = next;
    try { localStorage.setItem("remote-desk-site.theme", next); } catch (e) {}
    label();
  });
})();
