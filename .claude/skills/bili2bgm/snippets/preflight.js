// Preflight: is this session logged into bilibili, and whose is it?
// Run in a *.bilibili.com tab via the claude-in-chrome javascript_tool.
// No placeholders — paste as-is.
//
// The uid comes from here and nowhere else. Never hardcode it, never ask the
// user for it: discovery is what lets this skill ship publicly and work for
// whoever is logged in (spec.md §6a.4).
//
// NOTE: the javascript_tool evaluates with REPL semantics — the value of the
// last expression is what comes back. The `await` in front of the IIFE is load
// bearing: without it the tool returns the unresolved Promise, which serializes
// as an empty object and looks like a silent failure. Keep it.
await (async () => {
  try {
    const r = await fetch('https://api.bilibili.com/x/web-interface/nav', { credentials: 'include' });
    const text = await r.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      // An HTML body here means the anti-bot wall, not a logged-out session.
      return { ok: false, blocked: true, status: r.status, detail: text.slice(0, 200) };
    }
    if (body.code === -412) return { ok: false, blocked: true, detail: 'code -412 on preflight' };
    return {
      ok: true,
      blocked: false,
      code: body.code,
      isLogin: body.data ? body.data.isLogin === true : false,
      mid: body.data ? (body.data.mid ?? null) : null,
    };
  } catch (e) {
    return { ok: false, blocked: false, detail: String(e && e.message ? e.message : e) };
  }
})();
