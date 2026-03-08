// Must be loaded before hands.js.
// MV3 extension pages enforce Trusted Types, which blocks hands.js from
// creating Workers with plain string URLs.  Defining a passthrough 'default'
// policy lets those internal Worker/script URL assignments through.
if (window.trustedTypes && trustedTypes.createPolicy) {
  try {
    trustedTypes.createPolicy('default', {
      createScriptURL: (url) => url,
      createHTML:      (html) => html,
      createScript:    (script) => script,
    });
  } catch {
    // Policy already exists.
  }
}
