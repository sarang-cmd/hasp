// The one escaping helper the phone needs.
//
// Every string rendered by the app comes from a vault, which means it comes from
// whatever a person typed or imported. Item names with angle brackets are a normal
// thing to import from a notes app.

export const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch],
  );
