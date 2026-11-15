# Servidor de licencias de Cabina Musical

Servidor pequeño (Node 18+, sin dependencias) que cobra el Premium mensual con Mercado Pago y valida las licencias.

## Cómo funciona

1. En la página, el botón **Suscribirse** abre `/assinar`, que lleva al pago de la suscripción en Mercado Pago.
2. Al terminar, Mercado Pago devuelve al cliente a `/licenca`, donde ve su licencia (`CAB-...`).
3. El cliente pega la licencia en el reproductor. La página consulta `/api/verificar?key=...`.
4. Cada verificación pregunta a Mercado Pago, así que quien cancela la suscripción pierde el Premium.

No usa base de datos: la licencia es el id de la suscripción más una firma con tu `LICENSE_SECRET`.

## Variables de entorno (en Render, pestaña Environment)

| Variable | Qué poner |
|---|---|
| `MP_ACCESS_TOKEN` | Access Token de producción de tu aplicación en Mercado Pago. Secreto. |
| `LICENSE_SECRET` | Texto aleatorio de 32 caracteres o más. Secreto. No lo cambies después: invalida todas las licencias. |
| `SITE_URL` | Dirección de tu reproductor, por ejemplo `https://tu-sitio.onrender.com` |
| `PUBLIC_URL` | Dirección de este servidor, por ejemplo `https://cabina-licencias.onrender.com` |
| `ADMIN_TOKEN` | Texto aleatorio de 12 caracteres o más, solo para crear el plan |
| `PRICE` | Precio mensual, por ejemplo `9.90` |
| `MP_PLAN_ID` | Se rellena después de crear el plan |

## Primer uso

1. Despliega con las variables de arriba (sin `MP_PLAN_ID`).
2. Abre `https://TU-SERVIDOR/admin/plano?token=TU_ADMIN_TOKEN` y toca **Criar plano** una sola vez.
3. Copia el id que aparece a `MP_PLAN_ID` y guarda.
4. En el `index.html` del reproductor, pon:
   - `CHECKOUT_URL: "https://TU-SERVIDOR/assinar"`
   - `LICENSE_VERIFY_URL: "https://TU-SERVIDOR/api/verificar"`

## Pruebas

`node test.js` ejecuta 22 comprobaciones con Mercado Pago simulado.

## Seguridad

- No pegues `MP_ACCESS_TOKEN` ni `LICENSE_SECRET` en el código ni en GitHub.
- Quien conozca el e-mail de un cliente podría ver su licencia en `/licenca`. El servidor limita los intentos por IP.
