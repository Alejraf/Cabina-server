"use strict";
/* Prueba local con Mercado Pago simulado. Ejecutar: node test.js */
process.env.MP_ACCESS_TOKEN = "TEST";
process.env.LICENSE_SECRET = "0123456789abcdef0123456789abcdef";
process.env.SITE_URL = "https://site.test/";
process.env.PUBLIC_URL = "https://srv.test";
process.env.ADMIN_TOKEN = "admintoken12345";
delete process.env.MP_PLAN_ID;

var assert = require("assert");
var http = require("http");

var ID_OK = "aaaaaaaaaabbbbbbbbbbccccccccccdd";
var ID_CANCEL = "ccccccccccddddddddddeeeeeeeeeeff";
var ID_PEND = "eeeeeeeeeeffffffffff0000000000aa";
var ID_OTHER = "11111111112222222222333333333344";
var calls = [];

global.fetch = async function (url, opts) {
  opts = opts || {};
  calls.push({ url: url, method: opts.method || "GET", body: opts.body, auth: opts.headers && opts.headers.Authorization });
  var u = new URL(url);
  function reply(status, obj) { return { ok: status < 300, status: status, json: async function () { return obj; } }; }
  if (u.pathname === "/preapproval_plan" && opts.method === "POST") return reply(201, { id: "plan123", init_point: "https://mp.test/checkout?preapproval_plan_id=plan123" });
  if (u.pathname === "/preapproval_plan/plan123") return reply(200, { id: "plan123", init_point: "https://mp.test/checkout?preapproval_plan_id=plan123" });
  if (u.pathname === "/preapproval/search") {
    var e = u.searchParams.get("payer_email");
    if (e === "pago@x.com") return reply(200, { results: [{ id: ID_OK, status: "authorized", preapproval_plan_id: "plan123" }] });
    if (e === "cancelado@x.com") return reply(200, { results: [{ id: ID_CANCEL, status: "cancelled" }] });
    return reply(200, { results: [] });
  }
  var m = /^\/preapproval\/([A-Za-z0-9]+)$/.exec(u.pathname);
  if (m) {
    var table = {};
    table[ID_OK] = { status: "authorized", preapproval_plan_id: "plan123" };
    table[ID_CANCEL] = { status: "cancelled", preapproval_plan_id: "plan123" };
    table[ID_PEND] = { status: "pending", preapproval_plan_id: "plan123" };
    table[ID_OTHER] = { status: "authorized", preapproval_plan_id: "outro-plano" };
    return table[m[1]] ? reply(200, Object.assign({ id: m[1] }, table[m[1]])) : reply(404, { message: "not found" });
  }
  return reply(500, {});
};

var app = require("./server.js");

function req(port, method, path, body) {
  return new Promise(function (resolve, reject) {
    var r = http.request({ port: port, method: method, path: path, headers: body ? { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) } : {} }, function (res) {
      var d = ""; res.on("data", function (c) { d += c; }); res.on("end", function () { resolve({ status: res.statusCode, headers: res.headers, body: d }); });
    });
    r.on("error", reject); if (body) r.write(body); r.end();
  });
}

(async function () {
  await new Promise(function (r) { app.server.listen(0, r); });
  var port = app.server.address().port;
  var n = 0;
  function ok(name) { n++; console.log("ok " + n + " - " + name); }

  /* plano (admin) */
  var r = await req(port, "GET", "/admin/plano?token=errado"); assert.strictEqual(r.status, 403); ok("admin sin token correcto: 403");
  r = await req(port, "GET", "/admin/plano?token=admintoken12345"); assert.strictEqual(r.status, 200); ok("admin con token muestra formulario");
  r = await req(port, "POST", "/admin/plano?token=admintoken12345", ""); assert.strictEqual(r.status, 200); assert.ok(r.body.indexOf("plan123") > 0); ok("crea plan y muestra MP_PLAN_ID");
  var created = JSON.parse(calls.filter(function (c) { return c.method === "POST"; })[0].body);
  assert.strictEqual(created.auto_recurring.frequency_type, "months"); assert.strictEqual(created.auto_recurring.currency_id, "BRL");
  assert.strictEqual(created.auto_recurring.transaction_amount, 9.9); assert.strictEqual(created.back_url, "https://srv.test/licenca");
  assert.strictEqual(calls[0].auth, "Bearer TEST"); ok("cuerpo del plan correcto (mensual, BRL, 9.90, back_url)");

  /* checkout */
  r = await req(port, "GET", "/assinar"); assert.strictEqual(r.status, 302); assert.strictEqual(r.headers.location, "https://mp.test/checkout?preapproval_plan_id=plan123"); ok("/assinar redirige al checkout");

  /* verificar */
  var key = app.makeKey(ID_OK);
  assert.ok(/^CAB-[A-Za-z0-9]+-[0-9A-F]{12}$/.test(key)); ok("formato de la clave");
  r = await req(port, "GET", "/api/verificar?key=" + encodeURIComponent(key)); assert.deepStrictEqual(JSON.parse(r.body), { valid: true }); ok("clave de suscripción activa: valid true");
  assert.strictEqual(r.headers["access-control-allow-origin"], "https://site.test"); ok("cabecera CORS del sitio");
  var before = calls.length;
  r = await req(port, "GET", "/api/verificar?key=" + encodeURIComponent(key.slice(0, -1) + (key.slice(-1) === "A" ? "B" : "A"))); assert.deepStrictEqual(JSON.parse(r.body), { valid: false });
  r = await req(port, "GET", "/api/verificar?key=DEMO-PREMIUM"); assert.deepStrictEqual(JSON.parse(r.body), { valid: false });
  r = await req(port, "GET", "/api/verificar"); assert.deepStrictEqual(JSON.parse(r.body), { valid: false });
  assert.strictEqual(calls.length, before); ok("clave falsificada, DEMO-PREMIUM y vacía: false sin consultar a Mercado Pago");
  r = await req(port, "GET", "/api/verificar?key=" + encodeURIComponent(app.makeKey(ID_CANCEL))); assert.deepStrictEqual(JSON.parse(r.body), { valid: false }); ok("suscripción cancelada: false");
  r = await req(port, "GET", "/api/verificar?key=" + encodeURIComponent(app.makeKey(ID_PEND))); assert.deepStrictEqual(JSON.parse(r.body), { valid: false }); ok("suscripción pendiente: false");
  r = await req(port, "GET", "/api/verificar?key=" + encodeURIComponent(app.makeKey(ID_OTHER))); assert.deepStrictEqual(JSON.parse(r.body), { valid: false }); ok("suscripción de otro plan: false");

  /* página de licencia */
  r = await req(port, "POST", "/licenca", "email=Pago%40x.com"); assert.strictEqual(r.status, 200); assert.ok(r.body.indexOf(key) > 0); ok("por e-mail con suscripción activa: muestra la clave");
  r = await req(port, "POST", "/licenca", "email=cancelado%40x.com"); assert.ok(r.body.indexOf("CAB-") < 0 && r.body.indexOf("Não encontramos") > 0); ok("e-mail con suscripción cancelada: sin clave");
  r = await req(port, "POST", "/licenca", "email=nadie%40x.com"); assert.ok(r.body.indexOf("Não encontramos") > 0); ok("e-mail desconocido: sin clave");
  r = await req(port, "POST", "/licenca", "email=no-es-email"); assert.strictEqual(r.status, 400); ok("e-mail inválido: 400");
  r = await req(port, "GET", "/licenca?preapproval_id=" + ID_OK); assert.ok(r.body.indexOf(key) > 0); ok("redirección con preapproval_id activo: muestra la clave");
  r = await req(port, "GET", "/licenca?preapproval_id=" + ID_PEND); assert.ok(r.body.indexOf("CAB-") < 0 && r.body.indexOf("confirmado") > 0); ok("preapproval_id pendiente: pide esperar");
  r = await req(port, "GET", "/licenca?preapproval_id=%3Cscript%3E"); assert.strictEqual(r.status, 400); assert.ok(r.body.indexOf("<script>alert") < 0 && r.body.indexOf("%3Cscript") < 0 && r.body.indexOf("&lt;script") < 0); ok("preapproval_id malicioso: 400 sin reflejarlo");
  r = await req(port, "GET", "/obrigado?preapproval_id=" + ID_OK); assert.strictEqual(r.status, 302); assert.strictEqual(r.headers.location, "/licenca?preapproval_id=" + ID_OK); ok("/obrigado redirige a /licenca conservando el id");
  r = await req(port, "GET", "/health"); assert.strictEqual(r.body, "ok"); ok("/health");
  r = await req(port, "GET", "/nada"); assert.strictEqual(r.status, 404); ok("ruta desconocida: 404");

  console.log("\nTodas las pruebas pasaron (" + n + ").");
  app.server.close(); process.exit(0);
})().catch(function (e) { console.error("FALLÓ:", e); process.exit(1); });
