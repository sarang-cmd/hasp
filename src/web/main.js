// Entry point. Applies the saved appearance before the first paint, then boots.

import { boot } from "./app.js";

boot().catch((err) => {
  const app = document.getElementById("app");
  if (app) {
    app.innerHTML = `<div class="gate"><div class="gate-card">
      <div class="gate-mark"><strong>Hasp</strong></div>
      <h1>Could not open the vault</h1>
      <p class="sub">${String(err.message || err)}</p>
      <p class="sub">Reload the page. If it keeps failing, the server is not running.</p>
    </div></div>`;
  }
});
