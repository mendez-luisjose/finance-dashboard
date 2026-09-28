(function(){
'use strict';

/* =========================================================================
   Conexión con el backend (Google Apps Script, desplegado como Web App)
   ---------------------------------------------------------------------
   Esta página ya NO vive dentro de Apps Script (por eso ya no existe
   google.script.run) — ahora es un sitio estático (p. ej. GitHub Pages) que
   habla con el backend por HTTP normal (fetch). El backend sigue siendo el
   mismo Google Sheet + el mismo Code.gs, solo que ahora expone los datos
   como una API JSON en vez de servir el HTML directamente.

   PASOS PARA CONFIGURAR (una sola vez, después de desplegar apps-script-backend):
     1. En el editor de Apps Script: Implementar > Administrar implementaciones
        > (icono de lápiz) > Nueva versión > Implementar. Copia la URL que
        termina en /exec.
     2. Pega esa URL abajo en API_BASE_URL.
     3. Cambia API_TOKEN por un valor largo y aleatorio, y usa EXACTAMENTE
        el mismo valor en CONFIG.API_TOKEN dentro de apps-script-backend/Code.gs.
   ========================================================================= */
var API_BASE_URL = 'https://script.google.com/macros/s/AKfycbwMHxuUNLfsM3eY_x5Ad9n8ZEqj3o71L-YD-v1HrDGGh13AYvU0QhNRfkK4kUBLy2RZ/exec';
var API_TOKEN = '12345';

// Lee los datos del dashboard (equivalente al antiguo google.script.run.getDashboardData()).
function apiGetDashboardData(onSuccess, onFail){
  fetch(API_BASE_URL + '?action=data&token=' + encodeURIComponent(API_TOKEN))
    .then(function(r){ if(!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function(res){ if(!res || res.ok===false) throw new Error((res && res.error) || 'Error del servidor'); onSuccess(res.data); })
    .catch(onFail);
}
// POST genérico con acción + token (equivalente a las llamadas de escritura de
// google.script.run). payload se combina con {action, token} en el cuerpo JSON;
// se envía SIN fijar Content-Type a propósito (fetch usa "text/plain" por
// defecto para un body de texto), porque así el navegador NO manda una
// petición preflight OPTIONS — que Apps Script no sabe responder — y Code.gs
// igual lo interpreta bien porque parsea el texto recibido como JSON.
function apiPost(action, payload, onSuccess, onFail){
  var body = Object.assign({ action: action, token: API_TOKEN }, payload || {});
  fetch(API_BASE_URL, { method: 'POST', body: JSON.stringify(body) })
    .then(function(r){ if(!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function(res){ if(!res || res.ok===false) throw new Error((res && res.error) || 'Error del servidor'); onSuccess(res.data); })
    .catch(onFail);
}

var EXPENSE_CATEGORIES=['Comida','Transporte','Servicios','Entretenimiento','Salud','Ropa','Educación','Suscripciones','Otros'];
var INCOME_CATEGORIES=['Salario','Freelance','Ventas','Regalo','Otros ingresos'];
var CAT_COLORS=['#c3e63c','#6e93c9','#e2685c','#57b98a','#8b7fd6','#e0a83e','#4fb0c6','#c97fae','#8f9779','#b0b7c6'];
var STRIPE_HEX={provincial:'#6e93c9',binance:'#e0a83e',zinli:'#8b7fd6',accent:'#c3e63c'};
var MONTHS_ES=['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
var MONTHS_ES_LONG=['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
var DAYS_ES_LONG=['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
var state={
  accounts:[],transactions:[],selectedMonth:null,editingId:null,editingType:'expense',txPage:0,bcv:null,
  bcvEur:null,binanceUsdt:null,calcRateKey:'usd',calcInverted:false,
  activeTab:'inicio',balanceHidden:false,accountsFilter:'ALL',favorites:{},searchQuery:'',
  detailMode:null,detailAccountId:null,detailMonth:null,chartCurrency:'VES',statsCurrency:'VES'
};
// Configuración de las 3 tasas que ofrece la Calculadora — cada una sabe de
// dónde sacar su valor (dentro de `state`), cómo llamarse y con qué unidad
// mostrar el monto en moneda extranjera (para no confundir $ con USDT, que
// no son lo mismo aunque ambos suelan rondar el mismo valor).
var CALC_RATES={
  usd:{ label:'Dólar BCV', unit:'$', unitName:'Dólares', unitSingular:'Dólar', get:function(){ return state.bcv; } },
  eur:{ label:'Euro BCV', unit:'€', unitName:'Euros', unitSingular:'Euro', get:function(){ return state.bcvEur; } },
  usdt:{ label:'USDT Binance', unit:'USDT', unitName:'USDT', unitSingular:'USDT', get:function(){ return state.binanceUsdt; } }
};
function calcRateValue(key){ var r=CALC_RATES[key]&&CALC_RATES[key].get(); return (r&&r.rate>0)?r.rate:null; }
// Igual que fmtUSD/fmtVES pero para un monto en moneda extranjera genérica (€
// o USDT no tienen aquí su propio Intl.NumberFormat con símbolo de moneda),
// usando el mismo formato numérico de 2 decimales que ya usa el resto del sitio.
function calcFmtForeign(key,value){
  var cfg=CALC_RATES[key],num=fmtNumUSD.format(Math.abs(Number(value)||0)),sign=(Number(value)||0)<0?'-':'';
  return key==='usdt' ? sign+num+' USDT' : sign+cfg.unit+num;
}
var TX_PAGE_SIZE=4;
var RECENT_TX_COUNT=4;
var prevTotals={ves:0,usd:0};
var pollTimer=null;
var AUTO_REFRESH_MS=20000; // 20s: suficiente para que un gasto enviado desde el Shortcut aparezca casi al instante
var fmtVES=new Intl.NumberFormat('es-VE',{style:'currency',currency:'VES',minimumFractionDigits:2,maximumFractionDigits:2});
var fmtUSD=new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',minimumFractionDigits:2,maximumFractionDigits:2});
var fmtRate=new Intl.NumberFormat('es-VE',{minimumFractionDigits:2,maximumFractionDigits:2});
var fmtNumVES=new Intl.NumberFormat('es-VE',{minimumFractionDigits:2,maximumFractionDigits:2});
var fmtNumUSD=new Intl.NumberFormat('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
// Solo el número, sin el prefijo de moneda (Bs.S / $): se usa donde el símbolo de
// moneda ya se muestra aparte (la píldora "Bs"/"$" junto a la cifra del balance),
// para no repetirlo y así dejarle más espacio a la cifra en pantallas angostas.
function fmtBare(a,c){a=Number(a)||0;var body=c==='USD'?fmtNumUSD.format(Math.abs(a)):fmtNumVES.format(Math.abs(a));return a<0?'-'+body:body}
function todayISO(){var d=new Date(),tz=d.getTimezoneOffset()*60000;return new Date(d.getTime()-tz).toISOString().slice(0,10)}
function currentMonthKey(){return todayISO().slice(0,7)} function monthKey(s){return(s||'').slice(0,7)}
function monthLabel(k){var p=k.split('-');return MONTHS_ES[parseInt(p[1],10)-1]+' '+p[0]}
function fmt(a,c){a=Number(a)||0;var body=c==='USD'?fmtUSD.format(Math.abs(a)):fmtVES.format(Math.abs(a));return a<0?'-'+body:body}
// Convierte un movimiento a su equivalente en $ usando la tasa BCV, para poder sumar
// ingresos/gastos en Bs y en $ dentro de un mismo total (así el resumen y las gráficas
// de Inicio muestran SIEMPRE todos los movimientos, sin depender de un selector de moneda).
function txAmountUsdEq(t){var a=Number(t.amount)||0;if(t.currency==='USD')return a;if(state.bcv&&state.bcv.rate>0)return a/state.bcv.rate;return 0}
// Igual que la anterior, pero convierte al equivalente en la moneda que se pida (VES o
// USD) usando la tasa BCV. La usan las gráficas de Inicio, que siempre suman TODOS los
// movimientos (en cualquier moneda original) y solo cambian en qué moneda se muestran.
function txAmountIn(t,cur){var a=Number(t.amount)||0;if(t.currency===cur)return a;if(!state.bcv||!(state.bcv.rate>0))return 0;return cur==='USD'?a/state.bcv.rate:a*state.bcv.rate}
// Solo la porción de un movimiento que fue originalmente en Bs, convertida a $ a
// la tasa BCV del día; los movimientos que ya eran en $ devuelven 0 (se excluyen
// por completo, a propósito: esta vista aísla "lo que se manejó en bolívares").
function txAmountBcvOnly(t){if(t.currency!=='VES')return 0;if(!state.bcv||!(state.bcv.rate>0))return 0;return(Number(t.amount)||0)/state.bcv.rate}
// Solo la porción de un movimiento que fue originalmente en $ (sin conversión);
// los movimientos en Bs devuelven 0. Es el espejo de txAmountBcvOnly: aísla
// "lo que de verdad se movió en dólares", para no confundirlo con el total
// combinado ("$ + Bs") que sí mezcla ambas monedas.
function txAmountUsdOnly(t){return t.currency==='USD'?(Number(t.amount)||0):0}
function escapeHtml(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function deriveStripe(s){s=String(s||'').toLowerCase();if(s.includes('provincial'))return'provincial';if(s.includes('binance'))return'binance';if(s.includes('zinli'))return'zinli';return'accent'}
function accountInitial(name){var s=String(name||'').trim();return s?s.charAt(0).toUpperCase():'?'}
function uid(){return'id-'+Math.random().toString(36).slice(2,10)+Date.now().toString(36)}
function accountById(id){return state.accounts.find(function(a){return a.id===id})||null}
function catColor(cat){var all=EXPENSE_CATEGORIES.concat(INCOME_CATEGORIES),i=all.indexOf(cat);if(i<0){i=0;for(var x=0;x<String(cat).length;x++)i=(i*31+String(cat).charCodeAt(x))>>>0}return CAT_COLORS[i%CAT_COLORS.length]}
function showToast(msg){var t=document.getElementById('toast');document.getElementById('toastMsg').textContent=msg;t.classList.add('show');clearTimeout(showToast.timer);showToast.timer=setTimeout(function(){t.classList.remove('show')},2800)}
function setCloudStatus(kind,text){
  ['syncBtn'].forEach(function(id){
    var btn=document.getElementById(id); if(!btn)return;
    btn.classList.remove('syncing','synced','error'); if(kind)btn.classList.add(kind);
    btn.disabled=(kind==='syncing'); if(text)btn.title=text;
  });
}

/* =========================================================================
   Favoritos de cuenta: preferencia puramente del navegador (no viaja a la
   hoja de cálculo), guardada con localStorage. Como esta página se abre
   siempre en el mismo teléfono/navegador del usuario, es un buen lugar
   para recordar un detalle de UI que no necesita sincronizarse.
   ========================================================================= */
function loadFavorites(){
  try{ state.favorites=JSON.parse(localStorage.getItem('ledger_favorites')||'{}'); }
  catch(e){ state.favorites={}; }
}
function toggleFavorite(id){
  state.favorites[id]=!state.favorites[id];
  try{ localStorage.setItem('ledger_favorites', JSON.stringify(state.favorites)); }catch(e){}
  renderCuentasScreen();
}

/* =========================================================================
   Router de pestañas (todo vive en una sola página de Apps Script; el
   "cambio de pantalla" es solo mostrar/ocultar contenedores con CSS)
   ========================================================================= */
function switchTab(tab){
  state.activeTab=tab;
  document.querySelectorAll('.screen').forEach(function(el){ el.classList.toggle('active', el.dataset.screen===tab); });
  document.querySelectorAll('.tab-btn').forEach(function(b){ b.classList.toggle('active', b.dataset.tab===tab); });
  // Las gráficas SVG miden el ancho real del contenedor; si estaba oculto
  // (display:none) medían 0, así que se vuelven a dibujar al mostrar la pantalla.
  if(tab==='inicio') renderCharts();
  if(tab==='cuentas') renderCuentasScreen();
  if(tab==='calculadora') renderCalculadora();
  // El botón "+" es para agregar un movimiento, algo que no aplica en la
  // Calculadora — se oculta ahí para que nunca tape la tarjeta (que ya usa
  // buena parte del alto de la pantalla) y para que la tarjeta se pueda
  // centrar usando todo el espacio disponible, no solo lo que sobra
  // reservando el hueco del botón.
  var fabEl=document.getElementById('fabAdd');
  if(fabEl) fabEl.classList.toggle('hidden', tab==='calculadora');
  window.scrollTo(0,0);
}

// Para cuentas en Bs (cuenta corriente, tarjeta de crédito, etc.): cuántos $
// equivaldría ese saldo a la tasa BCV del día. Devuelve '' si la cuenta ya es
// en $ o si aún no tenemos tasa (para no mostrar un "≈ $0.00" engañoso).
function accountBcvEqHtml(a){
  if(a.currency!=='VES'||!state.bcv||!(state.bcv.rate>0))return'';
  return'<div class="balance-eq num">≈ '+fmtUSD.format((Number(a.balance)||0)/state.bcv.rate)+' BCV</div>';
}
function renderAccountsAndTotals(){
  var row=document.getElementById('accountsRow'),sorted=state.accounts.slice().sort(function(a,b){return(a.order||0)-(b.order||0)});
  row.innerHTML=sorted.map(function(a){return'<div class="acc-card anim" style="--stripe:var(--'+deriveStripe(a.institution)+')"><div class="row1"><span class="inst">'+escapeHtml(a.institution)+'</span><span class="tag">'+escapeHtml(a.type||'Cuenta')+'</span></div><div class="name">'+escapeHtml(a.name)+'</div><div class="balance num">'+fmt(a.balance,a.currency)+'</div>'+accountBcvEqHtml(a)+'</div>'}).join('');
  var v=0,u=0;
  state.accounts.forEach(function(a){if(a.currency==='VES')v+=Number(a.balance)||0;else u+=Number(a.balance)||0});
  prevTotals={ves:v,usd:u};
  renderBalanceFigure();
  renderBcvNote();
  renderCuentasScreen();
}
function renderBalanceFigure(){
  var vesEl=document.getElementById('balanceFigureVes'),usdEl=document.getElementById('balanceFigureUsd');
  if(vesEl)vesEl.textContent=fmtBare(prevTotals.ves,'VES');
  if(usdEl)usdEl.textContent=fmtBare(prevTotals.usd,'USD');
  var dual=document.getElementById('balanceDual');
  if(dual)dual.classList.toggle('blurred', !!state.balanceHidden);
}
function renderHeader(){
  var el=document.getElementById('todayLabel'); if(!el)return;
  var d=new Date();
  el.textContent=DAYS_ES_LONG[d.getDay()]+', '+d.getDate()+' de '+MONTHS_ES_LONG[d.getMonth()]+' de '+d.getFullYear();
}
// Fecha "Lunes 28 Septiembre" (día de la semana + mes completo, ambos con
// mayúscula inicial) — la usa la Calculadora para la fecha de cada tasa.
function fmtBcvDate(iso){
  if(!iso)return'';
  var p=String(iso).split('-');
  if(p.length<3)return'';
  var y=parseInt(p[0],10),m=parseInt(p[1],10)-1,d=parseInt(p[2],10);
  if(isNaN(y)||isNaN(m)||isNaN(d)||!MONTHS_ES_LONG[m])return'';
  var month=MONTHS_ES_LONG[m];
  // Se arma con y/m/d en hora local (no `new Date(iso)`) para que el día de
  // la semana no se corra por el desfase de interpretar el string como UTC.
  var weekday=DAYS_ES_LONG[new Date(y,m,d).getDay()];
  return weekday.charAt(0).toUpperCase()+weekday.slice(1)+' '+d+' '+month.charAt(0).toUpperCase()+month.slice(1);
}
function renderBcvNote(){
  var lineEl=document.getElementById('balanceBcvLine');
  if(!state.bcv||!(state.bcv.rate>0)){
    if(lineEl)lineEl.style.display='none';
    return;
  }
  var usdEq=prevTotals.ves/state.bcv.rate,rateTxt=fmtRate.format(state.bcv.rate);
  if(lineEl){lineEl.style.display='block';lineEl.innerHTML='≈ <span class="amt">'+fmtUSD.format(usdEq)+'</span> BCV · Bs '+rateTxt+' / $';}
}
function allMonthKeys(){var s={};s[currentMonthKey()]=true;state.transactions.forEach(function(t){if(monthKey(t.date))s[monthKey(t.date)]=true});return Object.keys(s).sort().reverse()}
function renderMonthTabs(){if(!state.selectedMonth)state.selectedMonth=currentMonthKey();var months=allMonthKeys();if(months.indexOf(state.selectedMonth)<0)state.selectedMonth=months[0];var w=document.getElementById('monthTabs');w.innerHTML=months.map(function(m){return'<button class="month-pill'+(m===state.selectedMonth?' active':'')+'" data-month="'+m+'">'+monthLabel(m)+(m===currentMonthKey()?' · actual':'')+'</button>'}).join('');w.querySelectorAll('.month-pill').forEach(function(b){b.onclick=function(){state.selectedMonth=b.dataset.month;state.txPage=0;renderMonthTabs();renderStats();renderCharts();renderTable()}})}
function txForMonth(m){return state.transactions.filter(function(t){return monthKey(t.date)===m})} function txForMonthCurrency(m,c){return txForMonth(m).filter(function(t){return t.currency===c})}
function searchFilter(list){
  if(!state.searchQuery)return list;
  var q=state.searchQuery.toLowerCase();
  return list.filter(function(t){
    var acc=accountById(t.accountId);
    var hay=[t.description,t.category,acc?acc.name:'',acc?acc.institution:''].join(' ').toLowerCase();
    return hay.indexOf(q)>-1;
  });
}
// Ingresos/Gastos/Balance del mes tienen su propio selector Bs/$/$+Bs
// (#statsCurSeg), con la MISMA idea que el selector de las gráficas de abajo:
// cada modo aísla una sola cosa, para no mezclar monedas sin que se note.
//  - Bs:    SOLO los movimientos cuya moneda original es Bs, en Bs (tal cual).
//  - $:     SOLO los movimientos cuya moneda original es $, en $ (tal cual).
//  - $+Bs:  TODOS los movimientos (en cualquier moneda), convertidos a $ y
//           sumados juntos — "de los $ gastados más los Bs, convertidos los
//           Bs a $ con la tasa BCV" — el total combinado de siempre.
// En Bs también se muestra, aparte, a cuánto equivaldría eso en $ a la tasa
// BCV (el sub-line); en $ y $+Bs no hace falta, porque ya están en $.
function statSubLineHtml(vesTotal){
  if(!state.bcv||!(state.bcv.rate>0))return'';
  var usdEq=vesTotal/state.bcv.rate,sign=usdEq<0?'-':'';
  return'<div class="value-sub num">≈ <span class="eq">'+sign+fmtUSD.format(Math.abs(usdEq))+'</span> BCV</div>';
}
function renderStats(){
  var incVes=0,expVes=0,incUsd=0,expUsd=0,incBlend=0,expBlend=0;
  txForMonth(state.selectedMonth).forEach(function(t){
    var blend=txAmountUsdEq(t);
    if(t.type==='income'){incBlend+=blend;incVes+=(t.currency==='VES'?(Number(t.amount)||0):0);incUsd+=txAmountUsdOnly(t);}
    else{expBlend+=blend;expVes+=(t.currency==='VES'?(Number(t.amount)||0):0);expUsd+=txAmountUsdOnly(t);}
  });
  var netVes=incVes-expVes,netUsd=incUsd-expUsd,netBlend=incBlend-expBlend;
  var cur=state.statsCurrency||'VES';
  function pick(ves,usd,blend){ return cur==='VES'?ves:(cur==='USD'?usd:blend); }
  var netShown=pick(netVes,netUsd,netBlend);
  function mainHtml(ves,usd,blend){ return cur==='VES' ? fmt(ves,'VES') : fmt(pick(ves,usd,blend),'USD'); }
  function subHtml(vesVal){ return cur==='VES' ? statSubLineHtml(vesVal) : ''; }
  document.getElementById('statStrip').innerHTML=
    '<div class="stat income"><div class="label">Ingresos del mes</div><div class="value num">'+mainHtml(incVes,incUsd,incBlend)+'</div>'+subHtml(incVes)+'</div>'+
    '<div class="stat expense"><div class="label">Gastos del mes</div><div class="value num">'+mainHtml(expVes,expUsd,expBlend)+'</div>'+subHtml(expVes)+'</div>'+
    '<div class="stat"><div class="label">Balance del mes</div><div class="value num" style="color:'+(netShown>=0?'var(--income)':'var(--expense)')+'">'+mainHtml(netVes,netUsd,netBlend)+'</div>'+subHtml(netVes)+'</div>';
  var incEl=document.querySelector('#statStrip .stat.income'),expEl=document.querySelector('#statStrip .stat.expense');
  if(incEl)incEl.onclick=function(){openDetailSheet('income')};
  if(expEl)expEl.onclick=function(){openDetailSheet('expense')};
}
function lastNMonths(n){var o=[],d=new Date();for(var i=n-1;i>=0;i--){var x=new Date(d.getFullYear(),d.getMonth()-i,1);o.push(x.getFullYear()+'-'+String(x.getMonth()+1).padStart(2,'0'))}return o}
// Gráficas dibujadas a mano con SVG (sin depender de ninguna librería externa
// como Chart.js): así funcionan siempre, incluso si una VPN o un bloqueador
// de contenido en el teléfono impide cargar scripts desde un CDN.
function svgEl(tag,attrs){var el=document.createElementNS('http://www.w3.org/2000/svg',tag);for(var k in attrs)el.setAttribute(k,attrs[k]);return el}
function roundedTopPath(x,y,w,h,r){if(h<=0||w<=0)return'';r=Math.min(r,w/2,h);return'M'+x+' '+(y+h)+' L'+x+' '+(y+r)+' Q'+x+' '+y+' '+(x+r)+' '+y+' L'+(x+w-r)+' '+y+' Q'+(x+w)+' '+y+' '+(x+w)+' '+(y+r)+' L'+(x+w)+' '+(y+h)+' Z'}
function niceMax(v){if(v<=0)return 10;var mag=Math.pow(10,Math.floor(Math.log(v)/Math.LN10)),norm=v/mag,step=norm<=1?1:norm<=2?2:norm<=5?5:10;return step*mag}
function showChartTooltip(evt,html){var tip=document.getElementById('chartTooltip');if(!tip)return;tip.innerHTML=html;tip.classList.add('show');positionChartTooltip(evt)}
function positionChartTooltip(evt){var tip=document.getElementById('chartTooltip');if(!tip)return;var x,y;if(evt.touches&&evt.touches[0]){x=evt.touches[0].pageX;y=evt.touches[0].pageY}else{x=evt.pageX;y=evt.pageY}tip.style.left=x+'px';tip.style.top=(y-12)+'px'}
function hideChartTooltip(){var tip=document.getElementById('chartTooltip');if(tip)tip.classList.remove('show')}
function wireTooltip(el,html){el.addEventListener('pointerenter',function(e){showChartTooltip(e,html)});el.addEventListener('pointermove',positionChartTooltip);el.addEventListener('pointerleave',hideChartTooltip);el.addEventListener('click',function(e){e.stopPropagation();showChartTooltip(e,html);clearTimeout(wireTooltip.t);wireTooltip.t=setTimeout(hideChartTooltip,2200)})}
function renderCharts(){renderTrendChart();renderCategoryChart()}
// El selector Bs/$/$ BCV/$+Bs tiene 4 modos, y ninguno mezcla monedas sin
// avisar (antes "Bs" convertía también los movimientos en $ a Bs con la tasa
// BCV, lo cual en la práctica mostraba dólares disfrazados de bolívares, no
// lo que realmente se movió en Bs):
//  - VES:   SOLO los movimientos cuya moneda original es Bs, en Bs (tal cual).
//  - USD:   SOLO los movimientos cuya moneda original es $, en $ (tal cual;
//           es el espejo de BCV: aísla lo que de verdad se movió en dólares).
//  - BCV:   SOLO los movimientos que ya eran en Bs, pero convertidos a $ a la
//           tasa BCV del día (para ver "a cuánto equivaldría en $ lo que se
//           manejó en bolívares"). Los que ya eran en $ se excluyen a propósito.
//  - USDBS ("$ + Bs"): TODOS los movimientos (en cualquier moneda), convertidos
//           a $ y sumados juntos — de los $ gastados más los Bs (convertidos a
//           $ con la tasa BCV) — el total combinado de siempre.
// Como BCV y USDBS siempre resultan en un valor en $, el formateo usa 'USD'
// aunque el modo seleccionado no se llame literalmente "USD".
function chartAmount(t,cur){
  if(cur==='USD')return txAmountUsdOnly(t);
  if(cur==='BCV')return txAmountBcvOnly(t);
  if(cur==='USDBS')return txAmountIn(t,'USD');
  return t.currency==='VES' ? (Number(t.amount)||0) : 0; // VES: solo lo que ya era Bs
}
function chartFmt(v,cur){ return (cur==='BCV'||cur==='USDBS') ? fmtUSD.format(v) : fmt(v,cur); }
function renderTrendChart(){
  var host=document.getElementById('trendChart');if(!host)return;host.innerHTML='';
  var months=lastNMonths(6),inc=[],exp=[];
  var cur=state.chartCurrency;
  months.forEach(function(m){var i=0,e=0;txForMonth(m).forEach(function(t){var v=chartAmount(t,cur);if(t.type==='income')i+=v;else e+=v});inc.push(i);exp.push(e)});
  var box=host.parentElement;
  var w=Math.max(box.clientWidth||300,260),h=Math.max(box.clientHeight||220,180);
  var padL=6,padR=6,padT=10,padB=26,plotW=w-padL-padR,plotH=h-padT-padB;
  var maxVal=niceMax(Math.max.apply(null,inc.concat(exp).concat([0])));
  var svg=svgEl('svg',{viewBox:'0 0 '+w+' '+h,width:'100%',height:'100%',preserveAspectRatio:'none'});
  var gridSteps=3;
  for(var g=0;g<=gridSteps;g++){var gy=padT+plotH-(plotH*g/gridSteps);svg.appendChild(svgEl('line',{x1:padL,y1:gy,x2:w-padR,y2:gy,stroke:'#1a1c22','stroke-width':1}))}
  var groupW=plotW/months.length,barGap=4,barW=Math.max(6,Math.min(16,(groupW-barGap*3)/2));
  months.forEach(function(m,idx){
    var gx=padL+idx*groupW,incH=(inc[idx]/maxVal)*plotH,expH=(exp[idx]/maxVal)*plotH;
    var bx1=gx+groupW/2-barGap/2-barW,bx2=gx+groupW/2+barGap/2;
    var incPath=roundedTopPath(bx1,padT+plotH-incH,barW,incH,3);
    var expPath=roundedTopPath(bx2,padT+plotH-expH,barW,expH,3);
    if(incPath){var pi=svgEl('path',{d:incPath,fill:'#57b98a',class:'chart-bar'});wireTooltip(pi,'<strong>Ingresos</strong> · '+monthLabel(m)+'<br>'+chartFmt(inc[idx],cur));svg.appendChild(pi)}
    if(expPath){var pe=svgEl('path',{d:expPath,fill:'#e2685c',class:'chart-bar'});wireTooltip(pe,'<strong>Gastos</strong> · '+monthLabel(m)+'<br>'+chartFmt(exp[idx],cur));svg.appendChild(pe)}
    var label=svgEl('text',{x:gx+groupW/2,y:h-8,'text-anchor':'middle',fill:'#6c6f7a','font-size':10});
    label.textContent=monthLabel(m).split(' ')[0];
    svg.appendChild(label);
  });
  host.appendChild(svg);
  var legend=document.getElementById('trendLegend');
  if(legend)legend.innerHTML='<span class="legend-item"><span class="legend-dot" style="background:#57b98a"></span>Ingresos</span><span class="legend-item"><span class="legend-dot" style="background:#e2685c"></span>Gastos</span>';
}
function renderCategoryChart(){
  var host=document.getElementById('catChart');if(!host)return;host.innerHTML='';
  var catBox=document.getElementById('catChartBox'),legend=document.getElementById('catLegend');
  var prevEmpty=catBox.querySelector('.empty-state');if(prevEmpty)prevEmpty.remove();
  var cur=state.chartCurrency;
  var by={};
  txForMonth(state.selectedMonth).filter(function(t){return t.type==='expense'}).forEach(function(t){by[t.category]=(by[t.category]||0)+chartAmount(t,cur)});
  // En modo Bs, $ o BCV (los tres aíslan una sola moneda), una categoría que
  // solo tuvo gastos en la otra moneda queda en 0: se descarta para no
  // mostrar un 0% o romper el cálculo del %. En $+Bs esto nunca pasa, porque
  // ese modo siempre suma todo.
  var cats=Object.keys(by).filter(function(c){return by[c]>0.004}).sort(function(a,b){return by[b]-by[a]});
  if(!cats.length){
    host.style.display='none';legend.innerHTML='';
    var d=document.createElement('div');d.className='empty-state';
    var hadAnyExpense=txForMonth(state.selectedMonth).some(function(t){return t.type==='expense'});
    if((cur==='BCV'||cur==='VES')&&hadAnyExpense){
      d.innerHTML='<div class="ico">🍩</div><div class="t">Sin gastos en bolívares</div><div class="s">Este mes no registraste gastos en Bs; los gastos en $ no aplican aquí.</div>';
    } else if(cur==='USD'&&hadAnyExpense){
      d.innerHTML='<div class="ico">🍩</div><div class="t">Sin gastos en dólares</div><div class="s">Este mes no registraste gastos en $; los gastos en Bs no aplican aquí.</div>';
    } else {
      d.innerHTML='<div class="ico">🍩</div><div class="t">Sin gastos este mes</div><div class="s">Registra un gasto para ver el desglose por categoría.</div>';
    }
    catBox.appendChild(d);
    return;
  }
  host.style.display='block';
  var total=cats.reduce(function(s,c){return s+by[c]},0);
  var box=host.parentElement;
  var size=Math.max(Math.min(box.clientWidth||240,box.clientHeight||240),160);
  var cx=size/2,cy=size/2,r=size/2-10,thickness=r*0.32,circumference=2*Math.PI*r;
  var svg=svgEl('svg',{viewBox:'0 0 '+size+' '+size,width:'100%',height:'100%'});
  var gapArc=cats.length>1?3:0,cumulative=0;
  cats.forEach(function(c){
    var frac=by[c]/total,segLen=frac*circumference,dash=Math.max(segLen-gapArc,0.001);
    var seg=svgEl('circle',{cx:cx,cy:cy,r:r,fill:'none',stroke:catColor(c),'stroke-width':thickness,'stroke-dasharray':dash+' '+(circumference-dash),'stroke-dashoffset':-cumulative,'stroke-linecap':'round',transform:'rotate(-90 '+cx+' '+cy+')',class:'donut-seg'});
    wireTooltip(seg,'<span class="tip-dot" style="background:'+catColor(c)+'"></span><strong>'+escapeHtml(c)+'</strong><br>'+chartFmt(by[c],cur)+' · '+Math.round(by[c]/total*100)+'%');
    cumulative+=segLen;
    svg.appendChild(seg);
  });
  var centerVal=svgEl('text',{x:cx,y:cy-3,'text-anchor':'middle','font-family':'var(--font-mono)','font-size':Math.max(12,Math.min(16,size*0.075)),'font-weight':700,fill:'#f3f4f6'});
  centerVal.textContent=chartFmt(total,cur);
  var centerLbl=svgEl('text',{x:cx,y:cy+15,'text-anchor':'middle','font-size':10,fill:'#6c6f7a'});
  centerLbl.textContent='Total gastado';
  svg.appendChild(centerVal);svg.appendChild(centerLbl);
  host.appendChild(svg);
  legend.innerHTML=cats.map(function(c){return'<div class="legend-row"><span class="legend-dot" style="background:'+catColor(c)+'"></span><span class="cat">'+escapeHtml(c)+' · '+Math.round(by[c]/total*100)+'%</span><span class="amt num">'+chartFmt(by[c],cur)+'</span></div>'}).join('');
}
function fmtDateShort(s){var d=new Date(s+'T00:00:00');return isNaN(d)?s:d.getDate()+' '+MONTHS_ES[d.getMonth()]+' '+d.getFullYear()}
// Para un movimiento registrado en Bs: a cuántos $ equivaldría a la tasa BCV del
// día. Devuelve '' para movimientos en $ o si aún no hay tasa disponible.
function txBcvEqHtml(t){
  if(t.currency!=='VES'||!state.bcv||!(state.bcv.rate>0))return'';
  return'<div class="amt-eq">≈ '+fmtUSD.format((Number(t.amount)||0)/state.bcv.rate)+'</div>';
}
function renderTable(){
  var txs=searchFilter(txForMonth(state.selectedMonth)).slice().sort(function(a,b){return(b.date||'').localeCompare(a.date||'')||(b.createdAt||'').localeCompare(a.createdAt||'')});
  var body=document.getElementById('txBody'),empty=document.getElementById('txEmpty'),pager=document.getElementById('txPager');
  if(!txs.length){
    body.innerHTML='';
    empty.style.display='block';
    empty.querySelector('.t').textContent = state.searchQuery ? 'Sin resultados' : 'Aún no hay movimientos este mes';
    empty.querySelector('div:nth-child(2)').textContent = state.searchQuery ? 'No encontramos movimientos que coincidan con "'+state.searchQuery+'".' : 'Registra tu primer ingreso o gasto para empezar a ver tus gráficas.';
    if(pager)pager.innerHTML='';
    return;
  }
  empty.style.display='none';
  var totalPages=Math.max(1,Math.ceil(txs.length/TX_PAGE_SIZE));
  if(!(state.txPage>=0))state.txPage=0;
  if(state.txPage>totalPages-1)state.txPage=totalPages-1;
  var start=state.txPage*TX_PAGE_SIZE,pageTxs=txs.slice(start,start+TX_PAGE_SIZE);
  body.innerHTML=pageTxs.map(function(t){
    var a=accountById(t.accountId),accName=a?a.name:'—';
    var meta=fmtDateShort(t.date)+' · '+escapeHtml(accName)+' · '+escapeHtml(t.category);
    return '<tr>'+
      '<td class="mobile-meta">'+meta+'</td>'+
      '<td data-label="Fecha">'+fmtDateShort(t.date)+'</td>'+
      '<td class="desc">'+escapeHtml(t.description||(t.type==='income'?'Ingreso':'Gasto'))+'</td>'+
      '<td data-label="Cuenta">'+escapeHtml(accName)+'</td>'+
      '<td data-label="Categoría"><span class="cat-chip">'+escapeHtml(t.category)+'</span></td>'+
      '<td class="amount num '+t.type+'" data-label="Monto"><div class="amt-main">'+(t.type==='income'?'+':'−')+' '+fmt(t.amount,t.currency)+'</div>'+txBcvEqHtml(t)+'</td>'+
      '<td class="actions-cell"><div class="row-actions"><button class="icon-btn edit" data-id="'+t.id+'">✎</button><button class="icon-btn del" data-id="'+t.id+'">✕</button></div></td>'+
    '</tr>';
  }).join('');
  body.querySelectorAll('.edit').forEach(function(b){b.onclick=function(){openModal('edit',b.dataset.id)}});
  body.querySelectorAll('.del').forEach(function(b){b.onclick=function(){askDelete(b.dataset.id)}});
  renderTxPager(txs.length,totalPages,start,pageTxs.length);
}
function renderTxPager(total,totalPages,start,shown){
  var pager=document.getElementById('txPager');if(!pager)return;
  if(total<=TX_PAGE_SIZE){pager.innerHTML='';return}
  pager.innerHTML='<button class="pager-btn" id="txPrevBtn"'+(state.txPage<=0?' disabled':'')+' aria-label="Anterior">‹</button>'+
    '<span class="pager-info">'+(start+1)+'–'+(start+shown)+' de '+total+'</span>'+
    '<button class="pager-btn" id="txNextBtn"'+(state.txPage>=totalPages-1?' disabled':'')+' aria-label="Siguiente">›</button>';
  var prev=document.getElementById('txPrevBtn'),next=document.getElementById('txNextBtn');
  prev.onclick=function(){if(state.txPage>0){state.txPage--;renderTable()}};
  next.onclick=function(){state.txPage++;renderTable()};
}

/* =========================================================================
   Movimientos recientes (preview en Inicio)
   ========================================================================= */
function renderRecentTx(){
  var host=document.getElementById('recentTxList');if(!host)return;
  var txs=state.transactions.slice().sort(function(a,b){return(b.date||'').localeCompare(a.date||'')||(b.createdAt||'').localeCompare(a.createdAt||'')}).slice(0,RECENT_TX_COUNT);
  if(!txs.length){host.innerHTML='<div class="recent-empty">Aún no hay movimientos registrados.</div>';return}
  host.innerHTML=txs.map(function(t){
    var a=accountById(t.accountId),accName=a?a.name:'—';
    return '<div class="recent-tx-row"><div class="meta"><div class="desc">'+escapeHtml(t.description||(t.type==='income'?'Ingreso':'Gasto'))+'</div><div class="sub">'+fmtDateShort(t.date)+' · '+escapeHtml(accName)+'</div></div><div class="amt '+t.type+'"><div class="amt-main">'+(t.type==='income'?'+':'−')+' '+fmt(t.amount,t.currency)+'</div>'+txBcvEqHtml(t)+'</div></div>';
  }).join('');
}

/* =========================================================================
   Pantalla Cuentas: dona + filtro por moneda + favoritos
   ========================================================================= */
function usdEquivalent(a){
  if(a.currency==='USD')return Number(a.balance)||0;
  if(state.bcv&&state.bcv.rate>0)return(Number(a.balance)||0)/state.bcv.rate;
  return null;
}
function renderCuentasScreen(){
  var filter=state.accountsFilter||'ALL';
  var list=state.accounts.filter(function(a){return filter==='ALL'?true:a.currency===filter});
  var withVal=list.map(function(a){var val=filter==='ALL'?usdEquivalent(a):(Number(a.balance)||0);return{a:a,val:val}});
  var totalBase=withVal.reduce(function(s,x){return s+(x.val||0)},0);
  withVal.sort(function(x,y){return(y.val||0)-(x.val||0)});

  var totalEl=document.getElementById('accountsTotalUsd');
  if(totalEl)totalEl.textContent=filter==='VES'?fmt(totalBase,'VES'):fmtUSD.format(totalBase);
  // Cuando el filtro es "Bolívares", el balance total ya se ve en Bs: aquí se
  // agrega, aparte, a cuántos $ equivaldría ese total a la tasa BCV del día.
  var totalEqEl=document.getElementById('accountsTotalEq');
  if(totalEqEl){
    if(filter==='VES'&&state.bcv&&state.bcv.rate>0){
      totalEqEl.style.display='block';
      totalEqEl.textContent='≈ '+fmtUSD.format(totalBase/state.bcv.rate)+' BCV';
    } else {
      totalEqEl.style.display='none';
      totalEqEl.textContent='';
    }
  }

  var countEl=document.getElementById('accountsCount');
  if(countEl)countEl.textContent=list.length+(list.length===1?' cuenta':' cuentas');

  var host=document.getElementById('accountsDonut');
  if(host){
    host.innerHTML='';
    if(withVal.length&&totalBase>0){
      var box=host.parentElement;
      var size=Math.max(Math.min(box.clientWidth||112,box.clientHeight||112),80);
      var cx=size/2,cy=size/2,r=size/2-8,thickness=r*0.34,circumference=2*Math.PI*r;
      var svg=svgEl('svg',{viewBox:'0 0 '+size+' '+size,width:'100%',height:'100%'});
      var gapArc=withVal.length>1?2:0,cumulative=0;
      withVal.forEach(function(x){
        var v=x.val||0;if(v<=0)return;
        var frac=v/totalBase,segLen=frac*circumference,dash=Math.max(segLen-gapArc,0.001);
        var hex=STRIPE_HEX[deriveStripe(x.a.institution)]||STRIPE_HEX.accent;
        var seg=svgEl('circle',{cx:cx,cy:cy,r:r,fill:'none',stroke:hex,'stroke-width':thickness,'stroke-dasharray':dash+' '+(circumference-dash),'stroke-dashoffset':-cumulative,'stroke-linecap':'round',transform:'rotate(-90 '+cx+' '+cy+')'});
        wireTooltip(seg,'<span class="tip-dot" style="background:'+hex+'"></span><strong>'+escapeHtml(x.a.name)+'</strong><br>'+Math.round(frac*100)+'%');
        cumulative+=segLen;
        svg.appendChild(seg);
      });
      host.appendChild(svg);
    }
  }

  var listEl=document.getElementById('accountsFullList');if(!listEl)return;
  if(!withVal.length){
    listEl.innerHTML='<div class="recent-empty">No hay cuentas en esta moneda todavía.</div>';
    return;
  }
  listEl.innerHTML=withVal.map(function(x){
    var a=x.a,pct=(totalBase>0&&x.val!=null)?Math.round((x.val/totalBase)*100):null;
    var fav=!!state.favorites[a.id];
    return '<div class="acc-full-row" data-id="'+a.id+'">'+
      '<div class="avatar" style="--stripe:var(--'+deriveStripe(a.institution)+')">'+accountInitial(a.institution)+'</div>'+
      '<div class="info"><div class="name">'+escapeHtml(a.name)+'</div><div class="inst">'+escapeHtml(a.institution)+'</div></div>'+
      '<div class="right"><div class="balance num">'+fmt(a.balance,a.currency)+'</div>'+accountBcvEqHtml(a)+(pct!=null?'<span class="pct-badge">'+pct+'%</span>':'')+'</div>'+
      '<button class="star-btn'+(fav?' fav':'')+'" data-star="'+a.id+'" aria-label="Favorito">'+(fav?'★':'☆')+'</button>'+
    '</div>';
  }).join('');
  listEl.querySelectorAll('.acc-full-row').forEach(function(row){
    row.addEventListener('click',function(e){
      if(e.target.closest('.star-btn'))return;
      var a=accountById(row.dataset.id);if(!a)return;
      openDetailSheet('account',a.id,a.name);
    });
  });
  listEl.querySelectorAll('.star-btn').forEach(function(btn){
    btn.addEventListener('click',function(e){e.stopPropagation();toggleFavorite(btn.dataset.star)});
  });
}

/* =========================================================================
   Hoja de detalle genérica: ingresos del mes / egresos del mes / cuenta
   ========================================================================= */
function openDetailSheet(mode,accountId,accountName){
  state.detailMode=mode;
  state.detailAccountId=accountId||null;
  state.detailMonth=state.selectedMonth||currentMonthKey();
  document.getElementById('detailTitle').textContent=mode==='income'?'Ingresos':mode==='expense'?'Egresos':(accountName||'Cuenta');
  renderDetailMonthTabs();
  renderDetailList();
  document.getElementById('detailBackdrop').classList.add('open');
}
function closeDetailSheet(){document.getElementById('detailBackdrop').classList.remove('open')}
function renderDetailMonthTabs(){
  var months=allMonthKeys();
  if(months.indexOf(state.detailMonth)<0)state.detailMonth=months[0];
  var w=document.getElementById('detailMonthTabs');if(!w)return;
  w.innerHTML=months.map(function(m){return'<button class="month-pill'+(m===state.detailMonth?' active':'')+'" data-month="'+m+'">'+monthLabel(m)+(m===currentMonthKey()?' · actual':'')+'</button>'}).join('');
  w.querySelectorAll('.month-pill').forEach(function(b){b.onclick=function(){state.detailMonth=b.dataset.month;renderDetailMonthTabs();renderDetailList()}});
}
function renderDetailList(){
  var mode=state.detailMode,m=state.detailMonth;
  var txs=state.transactions.filter(function(t){
    if(monthKey(t.date)!==m)return false;
    if(mode==='account')return t.accountId===state.detailAccountId;
    return t.type===mode;
  }).slice().sort(function(a,b){return(b.date||'').localeCompare(a.date||'')||(b.createdAt||'').localeCompare(a.createdAt||'')});
  var listEl=document.getElementById('detailList'),emptyEl=document.getElementById('detailEmpty'),
      emptyTitle=document.getElementById('detailEmptyTitle'),emptyDesc=document.getElementById('detailEmptyDesc');
  if(!txs.length){
    listEl.innerHTML='';listEl.style.display='none';emptyEl.style.display='block';
    var ml=monthLabel(m);
    if(mode==='income'){emptyTitle.textContent='Sin ingresos';emptyDesc.textContent='No hay ingresos en '+ml+'.'}
    else if(mode==='expense'){emptyTitle.textContent='Sin egresos';emptyDesc.textContent='No hay egresos en '+ml+'.'}
    else{emptyTitle.textContent='Sin movimientos';emptyDesc.textContent='No hay movimientos en '+ml+' para esta cuenta.'}
    return;
  }
  emptyEl.style.display='none';listEl.style.display='flex';
  listEl.innerHTML=txs.map(function(t){
    var a=accountById(t.accountId),accName=a?a.name:'—';
    var sub=mode==='account'?(fmtDateShort(t.date)+' · '+escapeHtml(t.category)):(fmtDateShort(t.date)+' · '+escapeHtml(accName));
    return '<div class="detail-row"><div class="meta"><div class="desc">'+escapeHtml(t.description||(t.type==='income'?'Ingreso':'Gasto'))+'</div><div class="sub">'+sub+'</div></div><div class="amt '+t.type+'"><div class="amt-main">'+(t.type==='income'?'+':'−')+' '+fmt(t.amount,t.currency)+'</div>'+txBcvEqHtml(t)+'</div></div>';
  }).join('');
}

/* =========================================================================
   Pantalla Calculadora: cuántos Bs equivale un monto según 3 tasas — dólar
   BCV, euro BCV o USDT (precio de compra en Binance P2P). El botón ⇅ invierte
   el cálculo (de Bs hacia la moneda elegida) sin tener que cambiar de pantalla.
   ========================================================================= */
function pulseCalcResult(){
  var el=document.getElementById('calcResultValue');if(!el)return;
  el.classList.remove('pulse');void el.offsetWidth;el.classList.add('pulse');
}
function renderCalcRateButtons(){
  var seg=document.getElementById('calcRateSeg');if(!seg)return;
  seg.querySelectorAll('button').forEach(function(b){b.classList.toggle('active',b.dataset.rate===state.calcRateKey)});
  var idMap={usd:'calcRateUsdValue',eur:'calcRateEurValue',usdt:'calcRateUsdtValue'};
  Object.keys(idMap).forEach(function(key){
    var el=document.getElementById(idMap[key]),rate=calcRateValue(key);
    if(el)el.textContent=rate?'Bs '+fmtRate.format(rate):'—';
  });
}
// Hora corta ("2:10 p. m.") a partir de un ISO datetime.
function fmtShortTime(iso){
  var d=new Date(iso);
  return isNaN(d) ? '' : d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
}
// Fecha + hora de actualización de una tasa, para el pie de la Calculadora.
// `date` es la fecha "del valor" (p. ej. la fecha que publica el BCV para su
// tasa del día); `fetchedAt` es cuándo la sincronizamos nosotros. Si no hay
// fecha propia (como con Binance, que no publica una), se usa la fecha de
// `fetchedAt` para no dejar el dato incompleto. Solo la fecha y la hora en sí
// van en <span class="amt"> (monoespaciada): el resto queda en texto normal
// para no competir con el número grande del resultado, arriba.
function calcMetaHtml(rateObj){
  if(!rateObj)return '<span class="amt">—</span>';
  var dateIso=rateObj.date||(rateObj.fetchedAt?String(rateObj.fetchedAt).slice(0,10):null);
  var dateTxt=dateIso?fmtBcvDate(dateIso):'';
  var timeTxt=rateObj.fetchedAt?fmtShortTime(rateObj.fetchedAt):'';
  // La fecha y el "Actualizado: hh:mm" van SIEMPRE en dos líneas separadas
  // (con un <br> real, no dejado al azar del ancho disponible): antes se
  // envolvían solo cuando no cabían juntas en una línea, lo que hacía que
  // la fila de BCV quedara en una línea y la de USDT en dos (o viceversa,
  // según la fecha/hora de cada una) — un salto de línea "a veces sí, a
  // veces no" que se veía descuadrado entre ambas filas, sobre todo en el
  // teléfono. Forzando siempre el mismo corte, las dos filas se ven
  // parejas sin importar el ancho de pantalla ni la fecha/hora exactas.
  if(dateTxt&&timeTxt)return '<span class="amt">'+dateTxt+'</span><br>Actualizado: <span class="amt">'+timeTxt+'</span>';
  if(dateTxt)return '<span class="amt">'+dateTxt+'</span>';
  if(timeTxt)return 'Actualizado: <span class="amt">'+timeTxt+'</span>';
  return '<span class="amt">—</span>';
}
function renderCalcNote(){
  var bcvEl=document.getElementById('calcMetaBcv'),usdtEl=document.getElementById('calcMetaUsdt');
  if(bcvEl)bcvEl.innerHTML=calcMetaHtml(state.bcv);
  if(usdtEl)usdtEl.innerHTML=calcMetaHtml(state.binanceUsdt);
}
function updateCalcResult(){
  var key=state.calcRateKey||'usd',cfg=CALC_RATES[key],rate=calcRateValue(key),inverted=!!state.calcInverted;
  var amountInput=document.getElementById('calcAmount'),amount=parseFloat(amountInput&&amountInput.value)||0;
  var labelEl=document.getElementById('calcAmountLabel'),prefixEl=document.getElementById('calcAmountPrefix');
  var resultSubEl=document.getElementById('calcResultSub'),resultValueEl=document.getElementById('calcResultValue');
  if(labelEl)labelEl.textContent=inverted?'Monto en Bolívares':('Monto en '+cfg.unitName);
  if(prefixEl)prefixEl.textContent=inverted?'Bs':cfg.unit;
  if(!rate){
    if(resultValueEl)resultValueEl.textContent='—';
    if(resultSubEl)resultSubEl.textContent='Tasa de '+cfg.label+' no disponible todavía. Sincroniza de nuevo en unos minutos.';
    return;
  }
  if(resultSubEl)resultSubEl.textContent='1 '+cfg.unitSingular+' = Bs '+fmtRate.format(rate);
  if(!resultValueEl)return;
  resultValueEl.textContent=inverted ? calcFmtForeign(key,amount/rate) : fmt(amount*rate,'VES');
}
function renderCalculadora(){renderCalcRateButtons();renderCalcNote();updateCalcResult()}
function renderAll(){renderAccountsAndTotals();renderMonthTabs();renderStats();renderTable();renderCharts();renderRecentTx()}
function populateAccountSelect(){document.getElementById('f-account').innerHTML=state.accounts.slice().sort(function(a,b){return(a.order||0)-(b.order||0)}).map(function(a){return'<option value="'+escapeHtml(a.id)+'">'+escapeHtml(a.name)+' — '+escapeHtml(a.institution)+' ('+a.currency+')</option>'}).join('')}
function populateCategoryList(){var list=state.editingType==='income'?INCOME_CATEGORIES:EXPENSE_CATEGORIES;document.getElementById('categoryList').innerHTML=list.map(function(c){return'<option value="'+c+'">'}).join('')}
function setType(t){state.editingType=t;document.querySelectorAll('#typeToggle button').forEach(function(b){b.classList.toggle('active',b.dataset.type===t)});populateCategoryList()}
function isModalOpen(){var b=document.getElementById('backdrop');return b&&b.classList.contains('open')}
function openModal(mode,id){populateAccountSelect();document.getElementById('txForm').reset();document.getElementById('f-date').value=todayISO();state.editingId=mode==='edit'?id:null;if(mode==='edit'){var t=state.transactions.find(function(x){return x.id===id});if(!t)return;document.getElementById('modalTitle').textContent='Editar movimiento';setType(t.type);document.getElementById('f-account').value=t.accountId;document.getElementById('f-amount').value=t.amount;document.getElementById('f-date').value=t.date;document.getElementById('f-category').value=t.category;document.getElementById('f-desc').value=t.description||''}else{document.getElementById('modalTitle').textContent='Agregar movimiento';setType('expense')}document.getElementById('backdrop').classList.add('open')}
function closeModal(){document.getElementById('backdrop').classList.remove('open');state.editingId=null}
function applyServerData(data,msg){state.accounts=data.accounts||[];state.transactions=data.transactions||[];state.bcv=data.bcv||null;state.bcvEur=data.bcvEur||null;state.binanceUsdt=data.binanceUsdt||null;if(!state.selectedMonth)state.selectedMonth=currentMonthKey();renderAll();if(state.activeTab==='calculadora')renderCalculadora();setCloudStatus('synced','Sincronizado con Google Sheets · '+new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}));if(msg)showToast(msg)}
function serverFail(err){console.error(err);setCloudStatus('error','No se pudo sincronizar con Google Sheets');showToast((err&&err.message)||'Error de sincronización');document.getElementById('saveBtn').disabled=false}
function syncData(show){
  // Evita pisar el formulario mientras el usuario está agregando/editando un movimiento a mano.
  if(isModalOpen())return;
  setCloudStatus('syncing','Sincronizando con Google Sheets…');
  apiGetDashboardData(function(d){applyServerData(d,show?'Datos actualizados':null)}, serverFail);
}
function startAutoRefresh(){
  stopAutoRefresh();
  // Refresca sola cada cierto tiempo para que un gasto enviado desde el
  // Shortcut del iPhone aparezca en el dashboard sin tener que tocar
  // "Sincronizar" manualmente.
  pollTimer=setInterval(function(){ if(!document.hidden) syncData(false) },AUTO_REFRESH_MS)
}
function stopAutoRefresh(){ if(pollTimer){ clearInterval(pollTimer); pollTimer=null } }
function submitTransaction(e){e.preventDefault();var acc=accountById(document.getElementById('f-account').value),amount=parseFloat(document.getElementById('f-amount').value),category=document.getElementById('f-category').value.trim();if(!acc||!(amount>0)||!category)return;var old=state.editingId?state.transactions.find(function(x){return x.id===state.editingId}):null;var tx={id:state.editingId||uid(),type:state.editingType,amount:amount,currency:acc.currency,accountId:acc.id,category:category,description:document.getElementById('f-desc').value.trim(),date:document.getElementById('f-date').value,createdAt:old?old.createdAt:new Date().toISOString()};document.getElementById('saveBtn').disabled=true;setCloudStatus('syncing','Guardando en Google Sheets…');apiPost('save_transaction',tx,function(d){document.getElementById('saveBtn').disabled=false;closeModal();state.selectedMonth=monthKey(tx.date);state.txPage=0;applyServerData(d,old?'Movimiento actualizado':'Movimiento guardado')},serverFail)}
function askDelete(id){var t=state.transactions.find(function(x){return x.id===id});if(!t||!confirm('¿Eliminar este movimiento de '+fmt(t.amount,t.currency)+'? Se ajustará el saldo de la cuenta.'))return;setCloudStatus('syncing','Eliminando movimiento…');apiPost('delete_transaction',{id:id},function(d){applyServerData(d,'Movimiento eliminado')},serverFail)}
function wire(){
  document.getElementById('syncBtn').onclick=function(){syncData(true)};
  document.getElementById('addBtn').onclick=function(){openModal('add')};
  var fabAdd=document.getElementById('fabAdd'); if(fabAdd) fabAdd.onclick=function(){openModal('add')};
  document.getElementById('cancelBtn').onclick=closeModal;
  document.getElementById('backdrop').onclick=function(e){if(e.target.id==='backdrop')closeModal()};
  document.getElementById('txForm').onsubmit=submitTransaction;
  document.querySelectorAll('#typeToggle button').forEach(function(b){b.onclick=function(){setType(b.dataset.type)}});

  // navegación por pestañas + accesos rápidos que saltan de pantalla
  document.querySelectorAll('.tab-btn').forEach(function(b){b.onclick=function(){switchTab(b.dataset.tab)}});
  document.querySelectorAll('[data-goto]').forEach(function(b){b.onclick=function(){switchTab(b.dataset.goto)}});

  // balance: ojo para ocultar (Bs y $ se muestran siempre juntos, sin selector)
  var eye=document.getElementById('eyeToggle');
  if(eye)eye.onclick=function(){state.balanceHidden=!state.balanceHidden;eye.textContent=state.balanceHidden?'🙈':'👁';renderBalanceFigure()};

  // moneda de las gráficas de Inicio (Ingresos vs. gastos / Gastos por categoría):
  // siempre suman TODOS los movimientos, esto solo cambia en qué moneda se muestran.
  var chartCurSeg=document.getElementById('chartCurSeg');
  if(chartCurSeg)chartCurSeg.querySelectorAll('button').forEach(function(b){b.onclick=function(){state.chartCurrency=b.dataset.cur;chartCurSeg.querySelectorAll('button').forEach(function(x){x.classList.toggle('active',x===b)});renderCharts()}});
  var statsCurSeg=document.getElementById('statsCurSeg');
  if(statsCurSeg)statsCurSeg.querySelectorAll('button').forEach(function(b){b.onclick=function(){state.statsCurrency=b.dataset.cur;statsCurSeg.querySelectorAll('button').forEach(function(x){x.classList.toggle('active',x===b)});renderStats()}});

  // Calculadora: selector de tasa (Dólar BCV / Euro BCV / USDT Binance), monto
  // y botón ⇅ para invertir el cálculo (de la moneda elegida hacia Bs, o al revés).
  var calcRateSeg=document.getElementById('calcRateSeg');
  if(calcRateSeg)calcRateSeg.querySelectorAll('button').forEach(function(b){b.onclick=function(){state.calcRateKey=b.dataset.rate;renderCalcRateButtons();updateCalcResult();pulseCalcResult()}});
  var calcAmount=document.getElementById('calcAmount');
  if(calcAmount)calcAmount.addEventListener('input',updateCalcResult);
  var calcSwapBtn=document.getElementById('calcSwapBtn');
  if(calcSwapBtn)calcSwapBtn.onclick=function(){state.calcInverted=!state.calcInverted;calcSwapBtn.classList.toggle('flipped',state.calcInverted);var amt=document.getElementById('calcAmount');if(amt)amt.value='';updateCalcResult();pulseCalcResult()};

  // filtro de moneda en Cuentas
  var accFilter=document.getElementById('accountsCurFilter');
  if(accFilter)accFilter.querySelectorAll('button').forEach(function(b){b.onclick=function(){state.accountsFilter=b.dataset.cur;accFilter.querySelectorAll('button').forEach(function(x){x.classList.toggle('active',x===b)});renderCuentasScreen()}});

  // buscador de movimientos
  var search=document.getElementById('txSearch');
  if(search)search.addEventListener('input',function(){state.searchQuery=search.value.trim();state.txPage=0;renderTable()});

  // hoja de detalle (ingresos / egresos / cuenta)
  var detailClose=document.getElementById('detailCloseBtn'); if(detailClose)detailClose.onclick=closeDetailSheet;
  var detailBackdrop=document.getElementById('detailBackdrop'); if(detailBackdrop)detailBackdrop.onclick=function(e){if(e.target.id==='detailBackdrop')closeDetailSheet()};

  // Al volver a la pestaña/app (por ejemplo, después de registrar un gasto
  // desde el Shortcut y regresar a Safari) se sincroniza al instante.
  document.addEventListener('visibilitychange',function(){ if(!document.hidden) syncData(false) });
  window.addEventListener('focus',function(){ syncData(false) });
  // Redibuja las gráficas SVG si cambia el tamaño de pantalla (p.ej. al girar el teléfono).
  var resizeTimer=null;
  window.addEventListener('resize',function(){ clearTimeout(resizeTimer); resizeTimer=setTimeout(function(){ if(state.activeTab==='inicio')renderCharts(); if(state.activeTab==='cuentas')renderCuentasScreen(); },200) });
}
document.addEventListener('DOMContentLoaded',function(){renderHeader();loadFavorites();wire();syncData(false);startAutoRefresh()});
// Red de seguridad: si el contenedor de una gráfica cambia de tamaño después
// de la primera pintura (por ejemplo, las fuentes web tardan en cargar y eso
// reflowea el layout, dejando el gráfico medido en 0 justo antes), se vuelve
// a dibujar todo lo que esté visible en ese momento.
if(window.ResizeObserver){
  var chartHosts=['trendChart','catChart','accountsDonut'].map(function(id){return document.getElementById(id)}).filter(Boolean);
  if(chartHosts.length){
    var lastSizes={};
    var ro=new ResizeObserver(function(entries){
      var changed=false;
      entries.forEach(function(en){
        var id=en.target.id,w=Math.round(en.contentRect.width);
        if(w>0&&lastSizes[id]!==w){lastSizes[id]=w;changed=true}
      });
      if(!changed)return;
      if(state.activeTab==='inicio')renderCharts();
      if(state.activeTab==='cuentas')renderCuentasScreen();
    });
    chartHosts.forEach(function(el){ro.observe(el)});
  }
}
window.addEventListener('load',function(){ if(state.activeTab==='inicio')renderCharts(); if(state.activeTab==='cuentas')renderCuentasScreen(); });
})();
