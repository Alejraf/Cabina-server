"use strict";
/*
  Servidor de licenças da Cabina Musical (sem dependências, Node 18+).

  Fluxo:
    1. O cliente toca em "Assinar" na página  -> GET /assinar  -> checkout da assinatura no Mercado Pago.
    2. Depois de pagar, o Mercado Pago volta para /licenca    -> o servidor mostra a licença (CAB-...).
    3. O cliente cola a licença no player    -> GET /api/verificar?key=...  -> {"valid": true|false}.

  A licença não fica guardada em banco de dados: é o id da assinatura mais uma assinatura HMAC.
  Cada verificação consulta o Mercado Pago, então quem cancela perde o Premium.
*/
const http = require("http");
const crypto = require("crypto");

const PORT = Number(process.env.PORT) || 10000;
const TOKEN = process.env.MP_ACCESS_TOKEN || "";
const SECRET = process.env.LICENSE_SECRET || "";
const SITE_URL = process.env.SITE_URL || "";
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const PRICE = Number(process.env.PRICE || "9.90");
const REASON = process.env.PLAN_REASON || "Cabina Musical Premium (mensal)";
let PLAN_ID = process.env.MP_PLAN_ID || "";
let planInit = "";

const ID_RE = /^[A-Za-z0-9]{10,64}$/;
const KEY_RE = /^CAB-([A-Za-z0-9]{10,64})-([0-9A-F]{12})$/;

/* ---------- utilidades ---------- */
function esc(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
function originOf(url) { try { return new URL(url).origin; } catch (e) { return ""; } }
function cors() { var o = originOf(SITE_URL); return o ? { "Access-Control-Allow-Origin": o, "Vary": "Origin" } : {}; }
function send(res, code, body, type, extra) {
  var h = Object.assign({ "Content-Type": type || "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }, extra || {});
  res.writeHead(code, h); res.end(body);
}
function sendJson(res, code, obj) { send(res, code, JSON.stringify(obj), "application/json; charset=utf-8", cors()); }
function sendHtml(res, code, html) { send(res, code, html, "text/html; charset=utf-8"); }
function readBody(req, max) {
  max = max || 4096;
  return new Promise(function (resolve, reject) {
    var d = "", n = 0;
    req.on("data", function (c) { n += c.length; if (n > max) { reject(new Error("corpo grande demais")); req.destroy(); return; } d += c; });
    req.on("end", function () { resolve(d); });
    req.on("error", reject);
  });
}
function safeEqual(a, b) {
  var x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
var hits = new Map();
function limited(req, max, windowMs) {
  var ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "?").split(",")[0].trim();
  var now = Date.now(), h = hits.get(ip);
  if (!h || now - h.t > windowMs) { hits.set(ip, { n: 1, t: now }); return false; }
  h.n++;
  return h.n > max;
}
setInterval(function () { var now = Date.now(); hits.forEach(function (v, k) { if (now - v.t > 3600000) hits.delete(k); }); }, 600000).unref();

/* ---------- Mercado Pago ---------- */
async function mp(path, method, body) {
  var r = await fetch("https://api.mercadopago.com" + path, {
    method: method || "GET",
    headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });
  var j = {};
  try { j = await r.json(); } catch (e) {}
  if (!r.ok) { var err = new Error("Mercado Pago respondeu " + r.status); err.status = r.status; err.body = j; throw err; }
  return j;
}

/* ---------- licenças ---------- */
function needSecret() { if (SECRET.length < 16) throw new Error("LICENSE_SECRET ausente ou curta (mínimo 16 caracteres)"); }
function sign(id) { return crypto.createHmac("sha256", SECRET).update(id).digest("hex").slice(0, 12).toUpperCase(); }
function makeKey(id) { needSecret(); return "CAB-" + id + "-" + sign(id); }
function parseKey(key) {
  needSecret();
  var m = KEY_RE.exec(String(key || "").trim());
  if (!m) return null;
  return safeEqual(m[2], sign(m[1])) ? m[1] : null;
}

var cache = new Map();
async function isActive(id) {
  var c = cache.get(id);
  if (c && Date.now() - c.t < (c.ok ? 300000 : 20000)) return c.ok;
  try {
    var j = await mp("/preapproval/" + encodeURIComponent(id));
    var ok = j.status === "authorized" && (!PLAN_ID || j.preapproval_plan_id === PLAN_ID);
    cache.set(id, { ok: ok, t: Date.now() });
    return ok;
  } catch (e) {
    if (e.status === 404) { cache.set(id, { ok: false, t: Date.now() }); return false; }
    if (c) return c.ok; /* se o Mercado Pago falhar, usa o último resultado conhecido */
    throw e;
  }
}
async function findActiveByEmail(email) {
  var q = "/preapproval/search?payer_email=" + encodeURIComponent(email) + (PLAN_ID ? "&preapproval_plan_id=" + encodeURIComponent(PLAN_ID) : "");
  var j = await mp(q);
  var list = Array.isArray(j.results) ? j.results : [];
  var hit = list.find(function (x) { return x && x.status === "authorized" && ID_RE.test(String(x.id)); });
  return hit ? String(hit.id) : null;
}
async function checkoutUrl() {
  if (!PLAN_ID) throw new Error("MP_PLAN_ID não configurado");
  if (!planInit) {
    try { var j = await mp("/preapproval_plan/" + encodeURIComponent(PLAN_ID)); if (j.init_point) planInit = j.init_point; } catch (e) {}
  }
  return planInit || "https://www.mercadopago.com.br/subscriptions/checkout?preapproval_plan_id=" + encodeURIComponent(PLAN_ID);
}

/* ---------- páginas ---------- */
function page(title, inner) {
  return '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    "<title>" + esc(title) + "</title><style>" +
    ":root{color-scheme:light dark;--bg:#eceef3;--fg:#15171f;--card:#fff;--line:#d3d7e0;--ac:#4f5df0;--acfg:#fff}" +
    "@media(prefers-color-scheme:dark){:root{--bg:#0e1016;--fg:#eef0f7;--card:#171a23;--line:#2a2f40;--ac:#8c97ff;--acfg:#0e1016}}" +
    "body{margin:0;padding:24px 16px;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}" +
    "main{max-width:520px;margin:0 auto;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px}" +
    "h1{font-size:1.3rem;margin:0 0 8px}code{display:block;word-break:break-all;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:12px;margin:12px 0}" +
    "input{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid var(--line);border-radius:8px;font:inherit;background:var(--bg);color:var(--fg)}" +
    "button,a.btn{display:inline-block;margin-top:12px;padding:10px 14px;border-radius:8px;border:0;background:var(--ac);color:var(--acfg);font:inherit;font-weight:600;text-decoration:none;cursor:pointer}" +
    ".muted{opacity:.75;font-size:.9rem}" +
    "</style></head><body><main>" + inner + "</main></body></html>";
}
function formHtml(msg) {
  return page("Licença Premium",
    "<h1>Sua licença Premium</h1>" +
    (msg ? "<p>" + esc(msg) + "</p>" : "") +
    "<p>Digite o e-mail que você usou no Mercado Pago para ver sua licença.</p>" +
    '<form method="post" action="/licenca"><input type="email" name="email" required autocomplete="email" placeholder="seu@email.com" aria-label="E-mail do Mercado Pago">' +
    '<button type="submit">Ver licença</button></form>');
}
function keyHtml(key) {
  var site = originOf(SITE_URL) ? SITE_URL : "";
  return page("Licença Premium",
    "<h1>Premium ativo. Obrigado!</h1>" +
    "<p>Esta é a sua licença:</p>" +
    '<code id="k">' + esc(key) + "</code>" +
    '<button type="button" id="c">Copiar licença</button>' +
    "<p>Volte ao player, toque em ★ Premium, cole o código e toque em Ativar.</p>" +
    (site ? '<a class="btn" href="' + esc(site) + '">Voltar ao player</a>' : "") +
    '<p class="muted">Guarde este código. Para vê-lo de novo, abra esta página e informe o e-mail do Mercado Pago.</p>' +
    "<script>document.getElementById('c').addEventListener('click',function(){var t=document.getElementById('k').textContent;" +
    "if(navigator.clipboard){navigator.clipboard.writeText(t).catch(function(){});}" +
    "var r=document.createRange();r.selectNodeContents(document.getElementById('k'));var s=getSelection();s.removeAllRanges();s.addRange(r);this.textContent='Copiado';});</script>");
}

/* ---------- rotas ---------- */
async function handle(req, res) {
  var u = new URL(req.url, "http://localhost");
  var path = u.pathname.replace(/\/+$/, "") || "/";

  if (req.method === "OPTIONS") return send(res, 204, "", "text/plain", Object.assign({ "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Max-Age": "600" }, cors()));
  if (path === "/health") return send(res, 200, "ok");
  if (path === "/") return send(res, 200, "Servidor de licenças da Cabina Musical");

  if (req.method === "GET" && path === "/assinar") {
    try { res.writeHead(302, { Location: await checkoutUrl(), "Cache-Control": "no-store" }); return res.end(); }
    catch (e) { return sendHtml(res, 503, page("Assinatura", "<h1>Assinatura indisponível</h1><p>Tente novamente mais tarde.</p>")); }
  }

  if (path === "/obrigado") { res.writeHead(302, { Location: "/licenca" + u.search }); return res.end(); }

  if (path === "/licenca") {
    if (limited(req, 20, 3600000)) return sendHtml(res, 429, formHtml("Muitas tentativas. Aguarde um pouco e tente de novo."));
    try {
      if (req.method === "GET") {
        var pid = u.searchParams.get("preapproval_id");
        if (!pid) return sendHtml(res, 200, formHtml(""));
        if (!ID_RE.test(pid)) return sendHtml(res, 400, formHtml("Link inválido."));
        if (await isActive(pid)) return sendHtml(res, 200, keyHtml(makeKey(pid)));
        return sendHtml(res, 200, formHtml("Seu pagamento ainda está sendo confirmado. Aguarde um minuto e recarregue, ou consulte pelo e-mail abaixo."));
      }
      if (req.method === "POST") {
        var form = new URLSearchParams(await readBody(req));
        var email = String(form.get("email") || "").trim().toLowerCase();
        if (!/^[^\s@]{1,64}@[^\s@]{1,255}$/.test(email)) return sendHtml(res, 400, formHtml("E-mail inválido."));
        var id = await findActiveByEmail(email);
        if (id && await isActive(id)) return sendHtml(res, 200, keyHtml(makeKey(id)));
        return sendHtml(res, 200, formHtml("Não encontramos uma assinatura ativa com esse e-mail. Se acabou de pagar, aguarde um minuto e tente de novo."));
      }
    } catch (e) {
      console.error("erro /licenca:", e.message, e.body ? JSON.stringify(e.body) : "");
      return sendHtml(res, 503, formHtml("Não foi possível consultar agora. Tente novamente em instantes."));
    }
  }

  if (req.method === "GET" && path === "/api/verificar") {
    if (limited(req, 120, 60000)) return sendJson(res, 429, { valid: false, error: "limite" });
    try {
      var id2 = parseKey(u.searchParams.get("key"));
      if (!id2) return sendJson(res, 200, { valid: false });
      return sendJson(res, 200, { valid: await isActive(id2) });
    } catch (e) {
      console.error("erro /api/verificar:", e.message);
      return sendJson(res, 503, { valid: false, error: "indisponível" });
    }
  }

  if (path === "/admin/plano") {
    var tok = u.searchParams.get("token") || "";
    var okAdmin = ADMIN_TOKEN.length >= 12 && safeEqual(tok, ADMIN_TOKEN);
    if (!okAdmin) return sendHtml(res, 403, page("Admin", "<h1>Acesso negado</h1>"));
    if (req.method === "GET") {
      return sendHtml(res, 200, page("Criar plano",
        "<h1>Criar plano mensal</h1><p>Preço: R$ " + esc(PRICE.toFixed(2)) + " por mês.</p>" +
        '<form method="post" action="/admin/plano?token=' + encodeURIComponent(tok) + '"><button type="submit">Criar plano</button></form>' +
        '<p class="muted">Toque uma única vez. Cada toque cria um plano novo.</p>'));
    }
    if (req.method === "POST") {
      if (!PUBLIC_URL.startsWith("https://")) return sendHtml(res, 400, page("Criar plano", "<h1>Falta PUBLIC_URL</h1><p>Defina PUBLIC_URL com o endereço https do servidor.</p>"));
      try {
        var plan = await mp("/preapproval_plan", "POST", {
          reason: REASON,
          auto_recurring: { frequency: 1, frequency_type: "months", transaction_amount: PRICE, currency_id: "BRL" },
          back_url: PUBLIC_URL + "/licenca"
        });
        PLAN_ID = String(plan.id); planInit = plan.init_point || "";
        return sendHtml(res, 200, page("Plano criado",
          "<h1>Plano criado</h1><p>Copie este valor para a variável <b>MP_PLAN_ID</b> no Render e salve:</p><code>" + esc(plan.id) + "</code>" +
          '<p class="muted">Sem isso, o plano se perde quando o servidor reiniciar.</p>'));
      } catch (e) {
        console.error("erro ao criar plano:", e.message, e.body ? JSON.stringify(e.body) : "");
        return sendHtml(res, 502, page("Criar plano", "<h1>Não foi possível criar o plano</h1><p>Verifique MP_ACCESS_TOKEN e os logs do servidor.</p>"));
      }
    }
  }

  return send(res, 404, "Não encontrado");
}

var server = http.createServer(function (req, res) {
  handle(req, res).catch(function (e) { console.error("erro:", e.message); if (!res.headersSent) send(res, 500, "Erro interno"); });
});

if (require.main === module) {
  if (!TOKEN) console.warn("AVISO: MP_ACCESS_TOKEN não definido.");
  if (SECRET.length < 16) console.warn("AVISO: LICENSE_SECRET ausente ou curta.");
  if (!PLAN_ID) console.warn("AVISO: MP_PLAN_ID não definido. Crie o plano em /admin/plano?token=SEU_ADMIN_TOKEN.");
  server.listen(PORT, function () { console.log("Servidor de licenças na porta " + PORT); });
}
module.exports = { server: server, makeKey: makeKey, parseKey: parseKey };
