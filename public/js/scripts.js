// =========================================================================
// ENCUESTA ITAPEBÍ — versión centralizada con Firebase (Firestore + Auth)
// -------------------------------------------------------------------------
// Flujo: el voto se guarda primero en IndexedDB (Dexie) como "pendiente" y
// luego se envía a Firestore. Si no hay internet, queda en cola y se envía
// solo cuando vuelve la conexión. El dashboard lee desde Firestore y exige
// iniciar sesión con la cuenta de administrador.
// =========================================================================

// 1. CONFIGURACIÓN ---------------------------------------------------------
// Copia estos datos desde Firebase Console → Configuración del proyecto → Tus apps (Web).
// No son secretos: la seguridad la dan las reglas de Firestore (firestore.rules).
 // Import the functions you need from the SDKs you need
  //import { initializeApp } from "https://www.gstatic.com/firebasejs/13.2.0/firebase-app.js";
  // TODO: Add SDKs for Firebase products that you want to use
  // https://firebase.google.com/docs/web/setup#available-libraries

  // Your web app's Firebase configuration
  const firebaseConfig = {
    apiKey: "AIzaSyDKcGvLf2Fero9ydOJ4jOW3pZArvJPJGpk",
    authDomain: "encuesta-itapebi.firebaseapp.com",
    projectId: "encuesta-itapebi",
    storageBucket: "encuesta-itapebi.firebasestorage.app",
    messagingSenderId: "291968738457",
    appId: "1:291968738457:web:10f9d52716b0f2ca74c408"
  };

// Initialize Firebase
//const app = initializeApp(firebaseConfig);

const FIREBASE_VERSION = "13.1.0";   // si la cambias, cámbiala también en sw.js
const HORAS_ENTRE_VOTOS = 12;        // límite por dispositivo en modo web
const LOTE_MAXIMO = 400;             // votos por envío (Firestore admite 500 por lote)

// Modo de uso:
//   - Kiosco (tablet en el local): abrir una vez con ?modo=kiosco  → se recuerda.
//   - Web (enlace compartido): por defecto. Un voto cada HORAS_ENTRE_VOTOS por dispositivo.
//   - El botón de Dashboard se muestra en modo kiosco o abriendo la página con ?admin
const params = new URLSearchParams(location.search);
if (params.get('modo') === 'kiosco') localStorage.setItem('modo', 'kiosco');
if (params.get('modo') === 'web') localStorage.removeItem('modo');
const MODO_KIOSCO = localStorage.getItem('modo') === 'kiosco';
const ORIGEN = MODO_KIOSCO ? 'kiosco' : 'web';

// 2. BASE DE DATOS LOCAL (cola de envío) -----------------------------------
const db = new Dexie("EncuestasDB");
db.version(1).stores({ votos: '++id, carita, fecha' });
// v2: tabla "pendientes" = votos aún no enviados al servidor.
// Los votos que ya estaban guardados en este dispositivo se migran para subirlos.
db.version(2).stores({ votos: '++id, carita, fecha', pendientes: 'id' }).upgrade(async tx => {
  const anteriores = await tx.table('votos').toArray();
  await tx.table('pendientes').bulkAdd(anteriores.map(v => crearVoto(v.carita, new Date(v.fecha))));
});

if (navigator.storage && navigator.storage.persist) navigator.storage.persist();

function mesLocal(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function crearVoto(carita, fecha = new Date()) {
  return {
    id: crypto.randomUUID(),     // ID único: evita duplicados si un envío se reintenta
    carita,
    fecha: fecha.toISOString(),
    mes: mesLocal(fecha),        // mes en hora local (Uruguay), para filtrar el dashboard
    origen: ORIGEN
  };
}

const datosVoto = ({ carita, fecha, mes, origen }) => ({ carita, fecha, mes, origen });

// 3. FIREBASE (carga diferida) ---------------------------------------------
// Se importa bajo demanda: si no hay internet, la votación sigue funcionando
// aunque Firebase no se pueda cargar.
let _firebase = null;
function firebase() {
  if (!_firebase) {
    _firebase = (async () => {
      const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/`;
      const [appMod, authMod, fsMod] = await Promise.all([
        import(base + 'firebase-app.js'),
        import(base + 'firebase-auth.js'),
        import(base + 'firebase-firestore-lite.js')
      ]);
      const app = appMod.initializeApp(firebaseConfig);
      const auth = authMod.getAuth(app);
      // La sesión de admin dura solo mientras la pestaña esté abierta
      await authMod.setPersistence(auth, authMod.browserSessionPersistence);
      return {
        auth,
        fs: fsMod.getFirestore(app),
        signInWithEmailAndPassword: authMod.signInWithEmailAndPassword,
        signOut: authMod.signOut,
        doc: fsMod.doc,
        setDoc: fsMod.setDoc,
        writeBatch: fsMod.writeBatch,
        collection: fsMod.collection,
        query: fsMod.query,
        where: fsMod.where,
        getDocs: fsMod.getDocs
      };
    })().catch(err => { _firebase = null; throw err; });
  }
  return _firebase;
}

// 4. SINCRONIZACIÓN ---------------------------------------------------------
let sincronizando = false;

async function sincronizar() {
  if (sincronizando || !navigator.onLine) return;
  sincronizando = true;
  let quedanMas = false;
  try {
    const pendientes = await db.pendientes.limit(LOTE_MAXIMO).toArray();
    if (!pendientes.length) return;
    const fb = await firebase();

    try {
      const lote = fb.writeBatch(fb.fs);
      pendientes.forEach(v => lote.set(fb.doc(fb.fs, 'votos', v.id), datosVoto(v)));
      await lote.commit();
      await db.pendientes.bulkDelete(pendientes.map(v => v.id));
    } catch (err) {
      if (err.code !== 'permission-denied') throw err;
      // Algún voto no cumple las reglas (dato corrupto): se envían de a uno y se descartan los inválidos
      for (const v of pendientes) {
        try {
          await fb.setDoc(fb.doc(fb.fs, 'votos', v.id), datosVoto(v));
        } catch (e) {
          if (e.code !== 'permission-denied') throw e;
          console.warn('Voto descartado por no cumplir las reglas:', v);
        }
        await db.pendientes.delete(v.id);
      }
    }
    quedanMas = pendientes.length === LOTE_MAXIMO;
  } catch (err) {
    console.warn('Sincronización pospuesta:', err.message || err);
  } finally {
    sincronizando = false;
  }
  if (quedanMas) sincronizar();
}

window.addEventListener('online', sincronizar);
window.addEventListener('load', sincronizar);
setInterval(sincronizar, 60 * 1000);

// 5. VOTACIÓN ---------------------------------------------------------------
function yaVotoRecientemente() {
  const ultimo = Number(localStorage.getItem('ultimoVoto') || 0);
  return Date.now() - ultimo < HORAS_ENTRE_VOTOS * 60 * 60 * 1000;
}

function mostrarGracias(titulo, mensaje) {
  document.getElementById('gracias-titulo').textContent = titulo;
  document.getElementById('gracias-mensaje').textContent = mensaje;
  document.getElementById('seccion-encuesta').style.display = 'none';
  document.getElementById('seccion-gracias').style.display = 'flex';

  // En el kiosco se vuelve a las caritas para el próximo cliente; en la web se queda aquí.
  if (MODO_KIOSCO) {
    setTimeout(() => {
      document.getElementById('seccion-gracias').style.display = 'none';
      document.getElementById('seccion-encuesta').style.display = 'block';
    }, 2000);
  }
}

async function votar(tipoCarita) {
  if (!MODO_KIOSCO && yaVotoRecientemente()) {
    return mostrarGracias('¡Ya recibimos tu opinión! ❤️', 'Gracias por ayudarnos a mejorar.');
  }
  try {
    await db.pendientes.add(crearVoto(tipoCarita));
    if (!MODO_KIOSCO) localStorage.setItem('ultimoVoto', String(Date.now()));
    mostrarGracias('¡Muchas Gracias! ❤️', 'Tu opinión nos ayuda a mejorar constantemente.');
    sincronizar();
  } catch (error) {
    console.error("Error guardando el voto:", error);
    alert("Hubo un problema al registrar tu voto.");
  }
}

// 6. ACCESO ADMINISTRATIVO --------------------------------------------------
if (!MODO_KIOSCO && !params.has('admin')) {
  document.querySelector('.btn-acceso-admin').style.display = 'none';
}

function solicitarAcceso() {
  document.getElementById('login-error').textContent = '';
  document.getElementById('modal-login').style.display = 'flex';
  document.getElementById('login-email').focus();
}

function cerrarLogin() {
  document.getElementById('modal-login').style.display = 'none';
  document.getElementById('login-password').value = '';
}

async function iniciarSesion(evento) {
  evento.preventDefault();
  const error = document.getElementById('login-error');
  const boton = document.getElementById('login-boton');
  error.textContent = '';
  boton.disabled = true;
  try {
    const fb = await firebase();
    await fb.signInWithEmailAndPassword(
      fb.auth,
      document.getElementById('login-email').value.trim(),
      document.getElementById('login-password').value
    );
    cerrarLogin();
    const selector = document.getElementById('selector-mes');
    selector.value = mesLocal(new Date());
    await abrirDashboard(selector.value);
  } catch (err) {
    error.textContent = !navigator.onLine || err.code === 'auth/network-request-failed'
      ? 'Sin conexión a internet. El dashboard necesita conexión.'
      : 'Correo o contraseña incorrectos.';
  } finally {
    boton.disabled = false;
  }
}

// 7. DASHBOARD --------------------------------------------------------------
let miGrafica = null;
let votosCargados = [];
let mesCargado = '';

async function abrirDashboard(mes) {
  const estado = document.getElementById('estado-dashboard');
  document.getElementById('dashboard').style.display = 'flex';
  estado.textContent = 'Cargando…';

  try {
    await sincronizar(); // sube primero lo pendiente de este dispositivo
    const fb = await firebase();
    const consulta = fb.query(fb.collection(fb.fs, 'votos'), fb.where('mes', '==', mes));
    const resultado = await fb.getDocs(consulta);
    votosCargados = resultado.docs.map(d => ({ id: d.id, ...d.data() }));
    mesCargado = mes;

    const totales = { Excelente: 0, Bueno: 0, Regular: 0, Malo: 0 };
    votosCargados.forEach(v => { if (totales[v.carita] !== undefined) totales[v.carita]++; });

    document.getElementById('lista-metricas').innerHTML = `
      <div class="metric-row"><span>🤩 Excelente:</span> <strong>${totales.Excelente}</strong></div>
      <div class="metric-row"><span>😊 Bueno:</span> <strong>${totales.Bueno}</strong></div>
      <div class="metric-row"><span>😐 Regular:</span> <strong>${totales.Regular}</strong></div>
      <div class="metric-row"><span>😡 Malo:</span> <strong>${totales.Malo}</strong></div>
      <div class="metric-row" style="border:none; margin-top:10px; font-size:1.4rem;">
        <span>Total:</span> <strong>${votosCargados.length} votos</strong>
      </div>
    `;

    const ctx = document.getElementById('graficaVotos').getContext('2d');
    if (miGrafica) miGrafica.destroy();
    miGrafica = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: ['Excelente', 'Bueno', 'Regular', 'Malo'],
        datasets: [{
          data: [totales.Excelente, totales.Bueno, totales.Regular, totales.Malo],
          backgroundColor: ['#4ADE80', '#6EE7B7', '#FCD34D', '#FCA5A5'],
          borderWidth: 2
        }]
      },
      options: { responsive: true, plugins: { legend: { position: 'bottom' } } }
    });

    const pendientes = await db.pendientes.count();
    estado.textContent = pendientes
      ? `⚠️ ${pendientes} voto(s) de este dispositivo aún no se enviaron.`
      : `Actualizado: ${new Date().toLocaleTimeString('es-UY')}`;
  } catch (error) {
    console.error("Error al cargar el dashboard:", error);
    estado.textContent = error.code === 'permission-denied'
      ? 'Esta cuenta no tiene permiso para ver los resultados.'
      : 'No se pudieron cargar los datos. Revisa la conexión.';
  }
}

function cambiarMes(mes) {
  if (mes) abrirDashboard(mes);
}

async function cerrarDashboard() {
  document.getElementById('dashboard').style.display = 'none';
  votosCargados = [];
  try {
    const fb = await firebase();
    await fb.signOut(fb.auth); // no dejar la sesión abierta en un equipo público
  } catch (_) { /* sin conexión: la sesión se borra al cerrar la pestaña */ }
}

// 8. EXPORTAR CSV (mes seleccionado, todos los dispositivos) ----------------
function exportarCSV() {
  if (!votosCargados.length) return alert("No hay datos que exportar.");
  const filas = [['ID', 'Carita', 'Fecha', 'Origen']]
    .concat(votosCargados
      .sort((a, b) => a.fecha.localeCompare(b.fecha))
      .map(v => [v.id, v.carita, v.fecha, v.origen]));
  const csv = '﻿' + filas.map(f => f.join(',')).join('\n'); // BOM: Excel respeta los acentos
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `reporte_votos_${mesCargado}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
