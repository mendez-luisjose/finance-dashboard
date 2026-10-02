# Mis Finanzas — dashboard (sitio estático + backend en Apps Script)

Este repositorio reemplaza la versión anterior del dashboard, que se servía
completa desde Google Apps Script. Ahora está dividido en dos partes:

- **El sitio** (`index.html`, `styles.css`, `app.js`, en la raíz de este
  repo): se aloja en GitHub Pages (o cualquier hosting estático) y es lo que
  abres en el teléfono.
- **El backend** (`apps-script-backend/`): sigue siendo Google Apps Script,
  conectado al mismo Google Sheet de siempre. Ya no sirve HTML, solo
  responde datos en JSON.

## ¿Por qué este cambio?

Google Apps Script sirve toda Web App dentro de un `<iframe>` propio (modo
sandbox IFRAME, obligatorio desde hace años), incluso cuando abres la URL
`/exec` directamente en el teléfono. Por eso, sin importar qué CSS le
pusiéramos, nunca lográbamos corregir del todo las franjas blancas de Safari
en iOS 26 ("Liquid Glass"): nuestro código nunca llegaba a tocar el borde
real de la pantalla, solo el borde del iframe de Google. Sirviendo el HTML
por fuera de Apps Script, en un sitio estático normal, ese problema
desaparece — el arreglo de las franjas (`.ios-glass-edge` en `styles.css`)
ahora sí debería funcionar en Safari.

## 1. Publicar el sitio en GitHub Pages

1. Sube todo el contenido de este repositorio a un repositorio de GitHub
   (puede ser público o privado; Pages funciona con ambos si tienes GitHub
   Pro, o público si tienes cuenta gratuita).
2. En el repositorio: **Settings → Pages**.
3. En "Source" elige **Deploy from a branch**, rama `main` (o la que uses),
   carpeta `/ (root)`.
4. Guarda. GitHub te da una URL parecida a
   `https://tu-usuario.github.io/tu-repo/`. Tarda uno o dos minutos en
   activarse la primera vez.

## 2. Desplegar el backend en Apps Script

La carpeta `apps-script-backend/` contiene un proyecto de Apps Script listo
para `clasp` (usa el mismo `scriptId` de tu proyecto "Ledger Personal"
actual, así que **reemplaza** el contenido de ese mismo proyecto — no crea
uno nuevo).

1. Desde la carpeta `apps-script-backend/`:
   ```
   npx clasp push
   ```
2. Abre el proyecto en [script.google.com](https://script.google.com) y
   **borra** los archivos que ya no se usan: `Index.html`, `Styles.html`,
   `App.html` (si `clasp push` no los quitó solo — clasp no borra archivos
   remotos que ya no están en tu carpeta local, así que probablemente
   sigan ahí; no hacen daño si los dejas, pero es más limpio quitarlos).
3. **Implementar → Administrar implementaciones → ✎ (editar) → Nueva
   versión → Implementar.** Esto es clave: edita la implementación
   existente (no crees una nueva), así la URL `/exec` no cambia y tu API
   de Shortcuts para iPhone (que es un proyecto de Apps Script totalmente
   aparte) sigue funcionando exactamente igual — este cambio no la toca.
4. Copia la URL que termina en `/exec`.
5. En `apps-script-backend/Code.gs`, cambia `CONFIG.API_TOKEN` (línea
   ~34) por un valor largo y aleatorio propio.
6. Vuelve a hacer `npx clasp push` y crea otra "Nueva versión" del
   despliegue para que el nuevo token quede activo.

### Probar el backend antes de conectar el sitio

Con el token ya configurado, abre en el navegador (o con `curl`):

```
https://TU_URL_DE_DESPLIEGUE/exec?action=data&token=TU_TOKEN
```

Deberías ver un JSON con tus cuentas, movimientos y la tasa BCV
(`{"ok":true,"data":{...}}`). Si ves `{"ok":false,"error":"Token
inválido."}`, revisa que el token en la URL coincida exactamente con
`CONFIG.API_TOKEN` en `Code.gs`.

## 3. Conectar el sitio con el backend

Edita `app.js` (líneas ~18-19, cerca del inicio del archivo):

```js
var API_BASE_URL = 'PEGA_AQUI_TU_URL_DE_DESPLIEGUE/exec';
var API_TOKEN = 'CAMBIA_ESTE_TOKEN';
```

- `API_BASE_URL`: la URL `/exec` que copiaste en el paso 2.
- `API_TOKEN`: el mismo valor exacto que pusiste en `CONFIG.API_TOKEN` en
  `Code.gs`.

Sube el cambio a GitHub (commit + push a la rama que usa Pages) y espera
uno o dos minutos a que se publique.

## 4. Probar

Abre la URL de GitHub Pages en Safari del iPhone. Debería sincronizar solo
al cargar (tal como antes), y esta vez las franjas de arriba/abajo deberían
verse del color oscuro del dashboard en vez de blancas. Si sigues viendo
franjas blancas después de este cambio, sería la primera señal real de que
es un límite de la plataforma (no de este código) y no de la arquitectura
Apps Script — avísame con la versión exacta de iOS para investigar más.

## Novedades: "$ + Bs" y la Calculadora

**"$ + Bs" en Resumen del Mes y Análisis.** El selector de moneda ya no
tiene solo "Bs" y "$": ahora "$" muestra SOLO lo que de verdad se movió en
dólares (sin convertir nada), y se agregó un tercer/cuarto botón **"$ + Bs"**
que suma todos los movimientos (en cualquier moneda) convertidos a $ —
de los $ gastados más los Bs, convertidos los Bs a $ con la tasa BCV. Antes
"$" ya hacía esta suma combinada por dentro (solo que sin nombrarlo así),
lo que hacía imposible ver el dato "solo lo que se movió en dólares" por
separado; ahora las tres/cuatro vistas son cada una una cosa distinta y
ninguna se pisa con otra:

- **Bs**: solo los movimientos en bolívares, en Bs.
- **$**: solo los movimientos en dólares, en $.
- **$ / BCV** (solo en Análisis): solo los movimientos en bolívares, pero
  convertidos a $ a la tasa BCV — para ver "a cuánto equivaldría en $ lo
  que se manejó en bolívares".
- **$ + Bs**: TODOS los movimientos, convertidos a $ y sumados — el total
  combinado.

**Pestaña Calculadora.** Pestaña aparte para saber cuántos bolívares equivale un monto, eligiendo entre
dos tasas: dólar BCV o euro BCV. Tiene un botón ⇅ para invertir el cálculo
(de Bs hacia la moneda elegida) y un botón 📋 junto al resultado para
copiarlo al portapapeles del dispositivo con un solo toque (muestra un ✓
como confirmación visual). Esto requiere que `apps-script-backend/Code.gs`
esté actualizado (ver más abajo) — si solo actualizas el sitio estático sin
redesplegar el backend, la Calculadora se ve bien pero las tasas se quedan
en "—" porque `getDashboardData()` todavía no le manda `bcvEur`.

Redespliega el backend igual que siempre: pega el nuevo `Code.gs` (o
`npx clasp push`) y luego **Implementar → Administrar implementaciones →
✎ → Nueva versión → Implementar** (edita la implementación existente, no
crees una nueva, para que la URL `/exec` no cambie).

Nota sobre USDT: la Calculadora ya no muestra la tasa de USDT de Binance
P2P (se quitó de la interfaz para simplificarla — solo quedan dólar BCV y
euro BCV). El backend sigue calculando `binanceUsdt` en `getDashboardData()`
por si se vuelve a necesitar más adelante, pero el frontend ya no la
consume en ningún lado. Si en algún momento quieres quitarla también del
backend, o quieres el detalle de cómo se calculaba (endpoint de anuncios
P2P, mediana de precios, función `debugBinanceUsdt`), avísame.

## Novedades: "Total en $" en el balance, pestaña Análisis y coma decimal

**"Total en $" primero en el balance.** La tarjeta de Balance (en Inicio)
ahora muestra PRIMERO, grande y arriba de todo, cuánto hay en total en $
sumando TODAS las cuentas — las que ya son $ tal cual, más las que son Bs
convertidas a $ a la tasa BCV del día. Antes solo se veían, lado a lado, el
total en Bs y el total en $ cada uno por separado (sin sumarse entre sí);
ese desglose se mantiene, ahora como detalle secundario debajo del total
combinado. El botón del ojo (👁) oculta/muestra los tres números juntos. Si
hay saldo en Bs pero todavía no se sincronizó la tasa BCV (primera carga,
sin conexión), el total combinado muestra "—" en vez de un número
incompleto.

**Pestaña Análisis (antes era parte de Inicio).** Las gráficas "Ingresos
vs. gastos" y "Gastos por categoría" (con su selector de moneda Bs / $ /
$ BCV / $ + Bs) ya no viven dentro de Inicio — ahora son su propia pestaña,
"📊 Análisis", entre Cuentas y Calculadora. Además, "Gastos por categoría"
ahora tiene su propio selector de mes (las mismas pastillas que ya se usan
en Movimientos), con una pastilla extra al principio, **"Todos los
meses"**, que suma las categorías de TODA la historia en vez de un solo
mes — para comparar un mes puntual contra el acumulado total. "Resumen del
Mes" (los tres números chicos de Ingresos/Gastos/Balance del mes, con su
propio selector Bs/$/$+Bs) se queda igual, dentro de Inicio.

**Coma decimal en la Calculadora (bug de iPhone).** El campo de monto de la
Calculadora era `<input type="number">`, y ese tipo de campo HTML solo
acepta el punto como separador decimal pase lo que pase en el idioma del
teléfono — en iOS ni siquiera dejaba teclear una coma ahí. Ahora es
`type="text"` con teclado numérico (`inputmode="decimal"`), y acepta tanto
"," como "." como separador decimal (convirtiéndolos internamente), que es
como se escriben los montos normalmente en Venezuela.

## Cosas que NO cambiaron

- El Google Sheet: mismo `SPREADSHEET_ID`, mismas hojas `Cuentas` y
  `Movimientos`, mismas columnas.
- El proyecto separado **"API Finanzas iPhone"** (el que usan tus Shortcuts
  para agregar ingresos/gastos y corregir saldos): es un proyecto de Apps
  Script totalmente distinto, no se toca con este cambio, y sigue
  funcionando igual.
- La lógica de negocio (cálculo de saldos, tasa BCV, categorías, etc.): es
  el mismo código, solo movido de sitio.

## Estructura del repositorio

```
index.html                    ← la página (súbela a GitHub Pages)
styles.css                    ← estilos (extraídos de lo que era Styles.html)
app.js                        ← lógica de la interfaz (extraído de App.html,
                                 con las llamadas a Apps Script cambiadas de
                                 google.script.run a fetch())
apps-script-backend/
  Code.gs                     ← backend: lee/escribe el Google Sheet, expone
                                 la API JSON (reemplaza tu Code.js actual)
  appsscript.json             ← configuración del proyecto de Apps Script
  .clasp.json                 ← apunta al mismo scriptId de "Ledger Personal"
```
