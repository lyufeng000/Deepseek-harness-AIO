// Host-side entry: this settings-only companion has no server half.
// Price settings and native balance APIs remain owned by the desktop shell.
// The loader (dsh 0.1.0-rc.6) rejects an empty default export, so the host
// half is a valid no-op Cordis plugin.
const name = "dsh-balance";
const inject = [];
function apply() {}
export { apply, inject, name };
