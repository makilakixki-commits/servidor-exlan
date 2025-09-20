const makeWASocket = require("@whiskeysockets/baileys").default;
const { useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require("qrcode-terminal");
const pino = require("pino");
const cors = require('cors');
const Groq = require('groq-sdk');
const { promisify } = require('util');
const path = require('path');
const admin = require('firebase-admin');
const fuzz = require('fuzzball');
const express = require('express');
const multer = require('multer');
const { ComputerVisionClient } = require("@azure/cognitiveservices-computervision");
const { ApiKeyCredentials } = require("@azure/ms-rest-js");
const fs = require("fs");
const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const { SpeechClient } = require('@google-cloud/speech');
const ffmpeg = require('fluent-ffmpeg'); // Para conversión de audio
const nodemailer = require('nodemailer');
const XLSX = require('xlsx');

const mensajesProcesados = new Set();

// ==== CONFIGURACIÓN EXPRESS ====
const app = express();
const PORT = 3001;

// 3. Configuración del correo electrónico
const EMAIL_CONFIG = {
    // Gmail configuration
    service: 'gmail',
    auth: {
        user: 'andercruzgutierrezz@gmail.com', // Cambia por tu email
        pass: 'ewtxipbrwdtjnbiz' // App password de Gmail (no tu contraseña normal)
    },
    //ewtx ipbr wdtj nbiz
    // Alternatively, for other email providers:
    // host: 'smtp.tu-proveedor.com',
    // port: 587,
    // secure: false,
    // auth: {
    //     user: 'tu-email@dominio.com',
    //     pass: 'tu-contraseña'
    // }
};

// Email de destino para los pedidos
const DESTINO_PEDIDOS = 'ander.cruz@alumni.mondragon.edu'; // Cambia por el email donde quieres recibir los pedidos
// Crear transporter de nodemailer
const transporter = nodemailer.createTransport(EMAIL_CONFIG);

// 👉 Pon aquí tus credenciales de Azure
const key = "8XHDpEk0qoNtN1zvASQIwONcGzHu0lL6DFX8Joi5kEzMPL1K52OLJQQJ99BIACYeBjFXJ3w3AAAFACOGRAG8";
const endpoint = "https://pruebaexlan.cognitiveservices.azure.com/";

const speechClient = new SpeechClient({
    keyFilename: path.join(__dirname, "exlan-web-f8ffe6410265.json") // Usa las mismas credenciales de Firebase
});

const computerVisionClient = new ComputerVisionClient(
    new ApiKeyCredentials({ inHeader: { "Ocp-Apim-Subscription-Key": key } }),
    endpoint
);

// Middleware
app.use(cors({origin: '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const sessions = {};
const sessionQRs = {};
const sessionStates = {};

function delay(ms) {
    return new Promise(res => setTimeout(res, ms));
}

// Configuración de multer para subida de archivos
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = './uploads/';
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1E9)}${path.extname(file.originalname)}`;
        cb(null, uniqueName);
    }
});

const upload = multer({
    storage: storage,
    limits: {
        fileSize: 16 * 1024 * 1024 // 16MB límite
    }
});

// ==== CONFIGURACIÓN ORIGINAL ====
const GROQ_API_KEY = "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";

// Configurar la variable de entorno para Google Cloud
process.env.GOOGLE_APPLICATION_CREDENTIALS = path.join(__dirname, "exlan-web-firebase-adminsdk-fbsvc-bd5e0f3dc4.json");

// Inicializar Firebase Admin
var serviceAccount = require("./exlan-web-firebase-adminsdk-fbsvc-bd5e0f3dc4.json");

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

let productosCache = []; // Cache de productos para fuzzy matching
let productosOtros = []; // Cache de productos para fuzzy matching

const groqClient = new Groq({ apiKey: GROQ_API_KEY });

// 🚀 Crear sesión
app.post('/start-session', async (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ success: false, message: 'Falta userId' });

    if (!sessions[userId]) {
        await createSession(userId);
    }
    return res.json({ success: true, message: 'Sesión iniciada' });
});

// 📡 Estado
app.get('/status/:userId', (req, res) => {
    const { userId } = req.params;
    const state = sessionStates[userId] || 'disconnected';
    res.json({ status: state });
});

// 📲 QR
app.get('/qr/:userId', (req, res) => {
    const { userId } = req.params;
    res.json({ qr: sessionQRs[userId] || null, status: sessionStates[userId] || 'unknown' });
});

// 🔌 Desconectar
app.post('/disconnect', async (req, res) => {
    const { userId } = req.body;
    if (sessions[userId]) {
        await sessions[userId].logout();
        delete sessions[userId];
        delete sessionQRs[userId];
        sessionStates[userId] = 'disconnected';
    }
    res.json({ success: true });
});

// 📤 Test conexión
app.post('/test-connection', async (req, res) => {
    const { userId, phoneNumber } = req.body;
    const sock = sessions[userId];

    if (!sock || sessionStates[userId] !== 'ready') {
        return res.status(400).json({ success: false, error: 'Sesión no conectada' });
    }

    try {
        const jid = `${phoneNumber}@s.whatsapp.net`;
        const sent = await sock.sendMessage(jid, { text: 'Mensaje de prueba desde Exlan ✅' });

        res.json({
            success: true,
            targetNumber: phoneNumber,
            messageId: sent.key.id,
            timestamp: new Date().toISOString(),
        });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Error enviando mensaje', details: err.message });
    }
});

// Endpoint para subir y enviar imagen
app.post('/upload-and-send', upload.single('image'), async (req, res) => {
    try {
        const { sessionName, phoneNumber, caption } = req.body;
        const file = req.file;

        // Validaciones
        if (!sessionName || !phoneNumber) {
            return res.status(400).json({
                error: 'Faltan campos requeridos: sessionName, phoneNumber'
            });
        }

        if (!file) {
            return res.status(400).json({
                error: 'No se subió ningún archivo'
            });
        }

        // Verificar que la sesión existe y está conectada
        const session = sessions[sessionName];
        if (!session) {
            // Limpiar archivo subido
            fs.unlinkSync(file.path);
            return res.status(404).json({
                error: `Sesión ${sessionName} no encontrada`
            });
        }

        // Formatear número de teléfono
        const formattedNumber = phoneNumber.includes('@') ? phoneNumber : `${phoneNumber}@s.whatsapp.net`;

        // Enviar imagen
        await session.sendMessage(formattedNumber, {
            image: { url: file.path },
            caption: caption || ''
        });

        console.log(`✅ Imagen subida y enviada a ${phoneNumber} desde sesión ${sessionName}`);

        // Opcional: eliminar archivo después de enviar
        setTimeout(() => {
            if (fs.existsSync(file.path)) {
                fs.unlinkSync(file.path);
                console.log(`🗑️ Archivo temporal eliminado: ${file.path}`);
            }
        }, 5000);

        res.json({
            success: true,
            message: 'Imagen subida y enviada correctamente',
            data: {
                sessionName,
                phoneNumber: formattedNumber,
                fileName: file.filename,
                originalName: file.originalname,
                size: file.size,
                caption
            }
        });

    } catch (error) {
        console.error('❌ Error subiendo y enviando imagen:', error);

        // Limpiar archivo en caso de error
        if (req.file && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }

        res.status(500).json({
            error: 'Error subiendo y enviando imagen',
            details: error.message
        });
    }
});

// Endpoint para obtener estado de las sesiones (MODIFICADO)
app.get('/sessions', (req, res) => {
    const sessionList = Object.keys(sessions).map(sessionName => ({
        sessionName,
        status: sessionStates[sessionName] || 'unknown',
        connected: sessionStates[sessionName] === 'connected',
        hasQR: !!sessionQRs[sessionName]
    }));

    res.json({
        success: true,
        sessions: sessionList,
        total: sessionList.length
    });
});

// Endpoint para enviar mensaje de texto (MODIFICADO)
app.post('/send-message', async (req, res) => {
    try {
        const { sessionName, phoneNumber, message } = req.body;

        if (!sessionName || !phoneNumber || !message) {
            return res.status(400).json({
                error: 'Faltan campos requeridos: sessionName, phoneNumber, message'
            });
        }

        const session = sessions[sessionName];
        if (!session) {
            return res.status(404).json({
                error: `Sesión ${sessionName} no encontrada`
            });
        }

        if (sessionStates[sessionName] !== 'connected' || sessionStates[sessionName] !== 'ready') {
            return res.status(400).json({
                error: `Sesión ${sessionName} no está conectada. Estado actual: ${sessionStates[sessionName]}`
            });
        }

        const formattedNumber = phoneNumber.includes('@') ? phoneNumber : `${phoneNumber}@s.whatsapp.net`;

        await session.sendMessage(formattedNumber, { text: message });

        console.log(`✅ Mensaje enviado a ${phoneNumber} desde sesión ${sessionName}`);

        res.json({
            success: true,
            message: 'Mensaje enviado correctamente',
            data: { sessionName, phoneNumber: formattedNumber, message }
        });

    } catch (error) {
        console.error('❌ Error enviando mensaje:', error);
        res.status(500).json({
            error: 'Error enviando mensaje',
            details: error.message
        });
    }
});

// ==== FUNCIONES ORIGINALES DE FIREBASE ====
async function cargarProductos() {
    try {
        console.log('🔄 Cargando productos desde Firebase...');
        const productosSnapshot = await db.collection('catalogo').get();
        productosCache = [];

        productosSnapshot.forEach(doc => {
            const data = doc.data();
            productosCache.push({
                id: doc.id,
                nombre: data.nombre,
                precio: data.precio || 0,
                stock: data.stock || 0,
                categoria: data.categoria || '',
                descripcion: data.descripcion || ''
            });
        });

        console.log(`✅ ${productosCache.length} productos cargados en cache`);
        return productosCache;
    } catch (error) {
        console.error('❌ Error cargando productos:', error);
        return [];
    }
}

async function cargarProductosOtros() {
    try {
        console.log('🔄 Cargando productos desde Firebase...');
        const productosSnapshot = await db.collection('otros').get();
        productosOtros = [];

        productosSnapshot.forEach(doc => {
            const data = doc.data();
            productosOtros.push({
                id: doc.id,
                nombre: data.nombre,
                precio: data.precio || 0,
                stock: data.stock || 0,
                categoria: data.categoria || '',
                descripcion: data.descripcion || ''
            });
        });

        console.log(`✅ ${productosOtros.length} productos cargados en cache`);
        return productosOtros;
    } catch (error) {
        console.error('❌ Error cargando productos:', error);
        return [];
    }
}

// ==== NUEVA FUNCIÓN: CARGAR HISTORIAL DE PEDIDOS DEL CLIENTE ====
async function cargarHistorialPedidos(numeroCliente) {
    try {
        console.log(`🔄 Cargando historial de pedidos para ${numeroCliente}...`);

        const clientesSnapshot = await db.collection('clientes')
            .where('telefono', '==', numeroCliente)
            .get();

        if (clientesSnapshot.empty) {
            console.log(`⚠️ No se encontró cliente con teléfono ${numeroCliente}`);
            return [];
        }

        const clienteId = clientesSnapshot.docs[0].id;
        const pedidosSnapshot = await db.collection('clientes')
            .doc(clienteId)
            .collection('pedidos')
            .orderBy('fechaCreacion', 'desc')
            .limit(50) // Últimos 50 pedidos
            .get();

        const productosHistorial = new Map();

        pedidosSnapshot.forEach(doc => {
            const pedido = doc.data();
            if (pedido.productos && Array.isArray(pedido.productos)) {
                pedido.productos.forEach(producto => {
                    const key = producto.id || producto.nombre;
                    if (!productosHistorial.has(key)) {
                        productosHistorial.set(key, {
                            id: producto.id,
                            nombre: producto.nombre,
                            precio: producto.precio,
                            frecuencia: 0
                        });
                    }
                    productosHistorial.get(key).frecuencia++;
                });
            }
        });

        const historial = Array.from(productosHistorial.values())
            .sort((a, b) => b.frecuencia - a.frecuencia);

        console.log(`✅ ${historial.length} productos únicos en el historial del cliente`);
        return historial;
    } catch (error) {
        console.error('❌ Error cargando historial de pedidos:', error);
        return [];
    }
}

// 🔎 Función para obtener la información de un cliente por teléfono
async function obtenerInfoCliente(numeroTelefono) {
    try {
        const clientesSnapshot = await db.collection('clientes')
            .where('telefono', '==', numeroTelefono)
            .limit(1) // por si hay duplicados, solo tomamos el primero
            .get();

        if (clientesSnapshot.empty) {
            console.log(`No se encontró cliente con teléfono: ${numeroTelefono}`);
            return null;
        }

        const clienteDoc = clientesSnapshot.docs[0];
        const clienteData = clienteDoc.data();

        // Estructuramos el objeto clienteInfo
        const clienteInfo = {
            id: clienteDoc.id,              // por si necesitas el ID del doc
            nombre: clienteData.nombre || '',
            telefono: clienteData.telefono || '',
            email: clienteData.email || '',
            direccion: clienteData.direccion || ''
        };

        return clienteInfo;

    } catch (error) {
        console.error("Error obteniendo información del cliente:", error);
        throw error;
    }
}

// ==== FUNCIÓN MEJORADA DE BÚSQUEDA ESCALONADA ====
async function buscarProductoEscalonado(nombreBuscado, numeroCliente) {
    const umbralMedio = 0.8;
    const umbralBajo = 0.6;
    const diferenciaSimilitud = 0.05; // para considerar "muy parecidos"

    // --- PASO 1: historial ---
    console.log(`🔍 Paso 1: Buscando "${nombreBuscado}" en historial del cliente...`);
    const historial = await cargarHistorialPedidos(numeroCliente);
    if (historial.length > 0) {
        const coincidenciasHistorial = encontrarCoincidencias(nombreBuscado, historial);

        if (coincidenciasHistorial[0] && coincidenciasHistorial[0].score >= umbralMedio) {
            const similares = coincidenciasHistorial.filter(c =>
                Math.abs(c.score - coincidenciasHistorial[0].score) < diferenciaSimilitud
            );

            if (similares.length > 1) {
                return {
                    producto: null,
                    fuente: 'historial',
                    opciones: similares.map(c => c.producto),
                    necesitaConfirmacion: true
                };
            }

            return {
                producto: coincidenciasHistorial[0].producto,
                fuente: 'historial',
                score: coincidenciasHistorial[0].score
            };
        }
    }

    // --- PASO 2: catálogo ---
    console.log(`🔍 Paso 2: Buscando "${nombreBuscado}" en catálogo...`);
    const coincidenciasCatalogo = encontrarCoincidencias(nombreBuscado, productosCache);

    if (coincidenciasCatalogo[0] && coincidenciasCatalogo[0].score >= umbralMedio) {
        const similares = coincidenciasCatalogo.filter(c =>
            Math.abs(c.score - coincidenciasCatalogo[0].score) < diferenciaSimilitud
        );

        if (similares.length > 1) {
            return {
                producto: null,
                fuente: 'catalogo',
                opciones: similares.map(c => c.producto),
                necesitaConfirmacion: true
            };
        }

        return {
            producto: coincidenciasCatalogo[0].producto,
            fuente: 'catalogo',
            score: coincidenciasCatalogo[0].score
        };
    }

    // --- PASO 3: otros ---
    console.log(`🔍 Paso 3: Buscando "${nombreBuscado}" en otros...`);
    const coincidenciasOtros = encontrarCoincidencias(nombreBuscado, productosOtros);

    if (coincidenciasOtros[0] && coincidenciasOtros[0].score >= umbralMedio) {
        const similares = coincidenciasOtros.filter(c =>
            Math.abs(c.score - coincidenciasOtros[0].score) < diferenciaSimilitud
        );

        if (similares.length > 1) {
            return {
                producto: null,
                fuente: 'otros',
                opciones: similares.map(c => c.producto),
                necesitaConfirmacion: true
            };
        }

        return {
            producto: coincidenciasOtros[0].producto,
            fuente: 'otros',
            score: coincidenciasOtros[0].score
        };
    }

    // --- SIN RESULTADOS BUENOS ---
    console.log(`❌ No se encontraron coincidencias buenas para "${nombreBuscado}"`);
    return {
        producto: null,
        fuente: 'ninguna',
        score: coincidenciasCatalogo[0] ? coincidenciasCatalogo[0].score : 0,
        sugerencias: obtenerSugerencias(nombreBuscado, [...historial, ...productosCache])
    };
}

function encontrarCoincidencias(nombreBuscado, productos, maxResultados = 5) {
    if (!productos.length) return [];

    const texto = nombreBuscado.toLowerCase();
    const palabrasBuscadas = texto.split(/\s+/);

    const pesos = {
        lata: 3,
        barril: 3,
        botella: 3,
        pack: 2,
        caja: 2,
        '0.0': 2,
        sin: 1,
        alcohol: 1
    };

    function calcularScore(nombreProducto, frecuencia = 1) {
        const palabrasProducto = nombreProducto.toLowerCase().split(/\s+/);
        let score = 0;

        for (const palabra of palabrasBuscadas) {
            const peso = pesos[palabra] || 1;
            const mejorCoincidencia = palabrasProducto.reduce((max, p) => {
                const sim = fuzz.ratio(palabra, p);
                return sim > max ? sim : max;
            }, 0);
            score += (mejorCoincidencia / 100) * peso;
        }

        const bonusFrecuencia = Math.min(frecuencia / 10, 0.1);
        score = (score / palabrasBuscadas.length) + bonusFrecuencia;

        return score;
    }

    const opciones = productos.map(producto => ({
        producto,
        score: calcularScore(producto.nombre, producto.frecuencia || 1)
    }));

    return opciones
        .sort((a, b) => b.score - a.score)
        .slice(0, maxResultados);
}

function obtenerSugerencias(nombreBuscado, productos, limite = 3) {
    const opciones = productos.map(producto => ({
        producto,
        score: fuzz.ratio(nombreBuscado.toLowerCase(), producto.nombre.toLowerCase()) / 100
    }));

    return opciones
        .sort((a, b) => b.score - a.score)
        .slice(0, limite)
        .filter(opcion => opcion.score > 0.3)
        .map(opcion => opcion.producto);
}

// ==== FUNCIÓN MEJORADA PARA GUARDAR PEDIDO ====
async function guardarPedidoEnFirebase(pedidoData, sender) {
    try {
        const timestamp = admin.firestore.FieldValue.serverTimestamp();
        const numeroCliente = sender.split('@')[0];

        const productosEncontrados = [];
        const productosNoEncontrados = [];
        const productosPendientes = []; // Productos que necesitan aclaración

        for (const item of pedidoData.productos) {
            const resultado = await buscarProductoEscalonado(item.nombre, numeroCliente);

            if (resultado.producto) {
                productosEncontrados.push({
                    id: resultado.producto.id,
                    nombre: resultado.producto.nombre,
                    nombreOriginal: item.nombre,
                    cantidad: item.cantidad,
                    precio: resultado.producto.precio,
                    subtotal: resultado.producto.precio * item.cantidad,
                    fuente: resultado.fuente,
                    score: resultado.score
                });
            } else {
                productosPendientes.push({
                    nombreOriginal: item.nombre,
                    cantidad: item.cantidad,
                    sugerencias: resultado.sugerencias || []
                });
            }
        }

        const total = productosEncontrados.reduce((sum, item) => sum + item.subtotal, 0);

        const pedido = {
            cliente: sender,
            productos: productosEncontrados,
            productosNoEncontrados,
            productosPendientes,
            total,
            estado: productosPendientes.length > 0 ? 'requiere_aclaracion' : 'pendiente',
            fechaCreacion: timestamp,
            textoOriginal: pedidoData.textoOriginal
        };

        // Guardar en Firebase
        const clientesSnapshot = await db.collection('clientes')
            .where('telefono', '==', numeroCliente)
            .get();

        if (!clientesSnapshot.empty) {
            const clienteDoc = clientesSnapshot.docs[0];
            const clienteId = clienteDoc.id;

            await db.collection('clientes')
                .doc(clienteId)
                .collection('pedidos')
                .add(pedido);

            console.log(`✅ Pedido guardado en clientes/${clienteId}/pedidos`);
        } else {
            console.log(`⚠️ No se encontró cliente con teléfono ${numeroCliente}`);
        }

        // Generar respuesta
        let resumen = `📋 *Pedido procesado*\n\n`;

        if (productosEncontrados.length > 0) {
            resumen += `✅ *Productos confirmados:*\n`;
            productosEncontrados.forEach(item => {
                const fuente = item.fuente === 'historial' ? '🔄' : '🆕';
                resumen += `${fuente} ${item.cantidad}x ${item.nombre} - $${item.subtotal.toFixed(2)}\n`;
            });
            resumen += `\n💰 *Subtotal confirmado:* $${total.toFixed(2)}\n\n`;
        }

        if (productosPendientes.length > 0) {
            resumen += `❓ *Productos que requieren aclaración:*\n`;
            productosPendientes.forEach(item => {
                resumen += `• ${item.cantidad}x "${item.nombreOriginal}"\n`;
                if (item.sugerencias.length > 0) {
                    resumen += `  📝 ¿Te refieres a?: ${item.sugerencias.map(s => s.nombre).join(', ')}\n`;
                }
            });
            resumen += `\nPor favor, especifica mejor estos productos o confirma si alguna sugerencia es correcta.\n`;
        }

        if (productosPendientes.length === 0) {
            resumen += `\n✅ Responde *"confirmar"* para procesar tu pedido.`;
        }

        return resumen;

    } catch (error) {
        console.error('❌ Error guardando pedido en Firebase:', error);
        return `Error guardando el pedido: ${error.message}`;
    }
}

// ==== FUNCIÓN MODIFICADA PARA CREAR SESIONES DINÁMICAMENTE ====
async function createSession(userId) {
    try {
        console.log(`🔄 Iniciando sesión: ${userId}`);

        // Cargar estado de autenticación desde carpeta ./auth/{userId}
        const { state, saveCreds } = await useMultiFileAuthState(`./auth/${userId}`);

        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' })
        });

        sessions[userId] = sock;
        sessionStates[userId] = 'initializing';

        // 📌 Manejo de conexión
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                sessionQRs[userId] = qr;
                sessionStates[userId] = 'qr_ready';
                console.log(`📱 QR listo para ${userId}`);
            }

            if (connection === 'open') {
                console.log(`🟢 Sesión ${userId} conectada`);
                sessionStates[userId] = 'ready';
                sessionQRs[userId] = null;
            }

            if (connection === 'close') {
                const shouldReconnect = lastDisconnect?.error instanceof Boom
                    ? lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut
                    : true;

                console.log(`🔴 Sesión ${userId} cerrada. reconnect=${shouldReconnect}`);

                if (shouldReconnect) {
                    sessionStates[userId] = 'reconnecting';
                    await delay(3000);
                    await createSession(userId);
                } else {
                    delete sessions[userId];
                    delete sessionQRs[userId];
                    sessionStates[userId] = 'disconnected';
                }
            }
        });

        // Guardar credenciales cuando se actualicen
        sock.ev.on('creds.update', saveCreds);

        // 📩 Manejo de mensajes entrantes
        sock.ev.on("messages.upsert", async ({ messages, type }) => {
            if (type === "notify") {
                const msg = messages[0];
                const messageId = msg.key.id;

                if (msg.key.fromMe && !mensajesProcesados.has(messageId)) {
                    const sender = msg.key.remoteJid;
                    const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text;
                    const image = msg.message?.imageMessage;
                    const audio = msg.message?.audioMessage;

                    mensajesProcesados.add(messageId);

                    if (text) {
                        console.log(`📩 [${userId}] Nuevo mensaje de ${sender}: ${text}`);

                        if (text.toLowerCase().includes("pedido")) {
                            console.log(`Procesando pedido de ${sender}...`);
                            const respuesta = await processWithGroq(text, sender);
                            await sock.sendMessage(sender, { text: respuesta });
                            return;
                        }

                        if (text.toLowerCase().includes("confirmado")) {
                            console.log(`📦 Procesando confirmación de ${sender}...`);
                            const numero = sender.split('@')[0];

                            // Buscar cliente por número
                            const clientesSnapshot = await db.collection('clientes')
                                .where('telefono', '==', numero)
                                .get();

                            if (!clientesSnapshot.empty) {
                                const clienteId = clientesSnapshot.docs[0].id;

                                const pedidosSnap = await db.collection('clientes')
                                    .doc(clienteId)
                                    .collection('pedidos')
                                    .where('estado', 'in', ['pendiente', 'requiere_aclaracion'])
                                    .get();


                                if (!pedidosSnap.empty) {
                                    const pedidoDoc = pedidosSnap.docs[0];
                                    const pedidoData = pedidoDoc.data();

                                    // Obtener información del cliente
                                    const clienteInfo = await obtenerInfoCliente(numero);

                                    if (clienteInfo) {
                                        // ✨ NUEVA FUNCIONALIDAD: Generar Excel y enviar por email
                                        console.log('📊 Iniciando generación de Excel y envío por email...');

                                        const resultadoCompleto = await generarYEnviarExcelPedido(pedidoData, clienteInfo);

                                        if (resultadoCompleto.success) {
                                            // Actualizar estado del pedido
                                            await pedidoDoc.ref.update({
                                                estado: 'confirmado',
                                                fechaConfirmacion: admin.firestore.FieldValue.serverTimestamp(),
                                                archivoExcel: resultadoCompleto.fileName,
                                                emailEnviado: resultadoCompleto.emailEnviado,
                                                destinatarioEmail: resultadoCompleto.destinatario
                                            });

                                            console.log(`✅ Pedido ${pedidoDoc.id} confirmado para ${numero}`);
                                            console.log(`📊 Excel generado: ${resultadoCompleto.fileName}`);
                                            console.log(`📧 Email enviado: ${resultadoCompleto.emailEnviado}`);

                                            let mensajeRespuesta = `✅ Tu pedido ha sido confirmado exitosamente.\n\n📊 Se ha generado un archivo Excel: ${resultadoCompleto.fileName}`;

                                            if (resultadoCompleto.emailEnviado) {
                                                mensajeRespuesta += `\n📧 El pedido ha sido enviado por email a ${resultadoCompleto.destinatario}`;
                                            } else {
                                                mensajeRespuesta += `\n⚠️ Hubo un problema enviando el email, pero el pedido está confirmado`;
                                            }

                                            mensajeRespuesta += `\n\n¡Gracias por tu pedido!`;

                                            await sock.sendMessage(sender, { text: mensajeRespuesta });

                                        } else {
                                            // Si hay error, aún confirmar el pedido
                                            await pedidoDoc.ref.update({
                                                estado: 'confirmado',
                                                fechaConfirmacion: admin.firestore.FieldValue.serverTimestamp()
                                            });

                                            console.log(`✅ Pedido ${pedidoDoc.id} confirmado para ${numero} (con errores en Excel/Email)`);

                                            await sock.sendMessage(sender, {
                                                text: `✅ Tu pedido ha sido confirmado.\n\n⚠️ Hubo un problema generando el Excel o enviando el email, pero tu pedido está registrado correctamente.`
                                            });
                                        }
                                    } else {
                                        // Cliente no encontrado, confirmar sin Excel
                                        await pedidoDoc.ref.update({ estado: 'confirmado' });
                                        console.log(`✅ Pedido ${pedidoDoc.id} confirmado para ${numero} (cliente no encontrado)`);

                                        await sock.sendMessage(sender, {
                                            text: `✅ Tu pedido ha sido confirmado.`
                                        });
                                    }

                                } else {
                                    console.log(`⚠️ No hay pedidos pendientes para ${numero}`);
                                    await sock.sendMessage(sender, { text: `⚠️ No tienes pedidos pendientes por confirmar.` });
                                }
                            } else {
                                console.log(`⚠️ No se encontró cliente con teléfono ${numero}`);
                                await sock.sendMessage(sender, { text: `⚠️ No encontramos un cliente registrado con tu número.` });
                            }

                            return;
                        }
                    } else if (image) {
                        console.log(`📸 [${userId}] Imagen recibida de ${sender}`);
                        console.log("🚀 Iniciando extracción de texto...");
                        if (!image) {
                            console.log('No se encontró una imagen en el mensaje');
                            return;
                        }

                        // Descargar la imagen del mensaje
                        const buffer = await downloadMediaMessage(msg, "buffer");

                        // Guardar la imagen en un archivo local (puedes usar cualquier nombre de archivo)
                        const imagePath = 'imagen.jpg';
                        fs.writeFileSync(imagePath, buffer);

                        // Llamar a la función leerTextoDesdeImagen() con el archivo de imagen
                        const texto = await leerTextoDesdeImagen(imagePath);
                        const respuesta = await processWithGroq(texto, sender);
                        await sock.sendMessage(sender, { text: respuesta });
                        return;
                    } else if (audio) {
                        console.log(`🎵 [${userId}] Audio recibido de ${sender}`);
                        await procesarAudioWhatsApp(msg, sock, sender);
                        return;
                    }
                } else if (!msg.key.fromMe && !mensajesProcesados.has(messageId)) {
                    const sender = msg.key.remoteJid;
                    const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text;
                    const image = msg.message?.imageMessage;
                    const audio = msg.message?.audioMessage;

                    mensajesProcesados.add(messageId);

                    if (text) {
                        console.log(`📩 [${userId}] Nuevo mensaje de ${sender}: ${text}`);

                        if (text.toLowerCase().includes("pedido")) {
                            console.log(`Procesando pedido de ${sender}...`);
                            const respuesta = await processWithGroq(text, sender);
                            await sock.sendMessage(sender, { text: respuesta });
                            return;
                        }
                    } else if (image) {
                        console.log(`📸 [${userId}] Imagen recibida de ${sender}`);
                        console.log("🚀 Iniciando extracción de texto...");
                        if (!image) {
                            console.log('No se encontró una imagen en el mensaje');
                            return;
                        }

                        // Descargar la imagen del mensaje
                        const buffer = await downloadMediaMessage(msg, "buffer");

                        // Guardar la imagen en un archivo local (puedes usar cualquier nombre de archivo)
                        const imagePath = 'imagen.jpg';
                        fs.writeFileSync(imagePath, buffer);

                        // Llamar a la función leerTextoDesdeImagen() con el archivo de imagen
                        const texto = await leerTextoDesdeImagen(imagePath);
                        const respuesta = await processWithGroq(texto, sender);
                        await sock.sendMessage(sender, { text: respuesta });
                        return;
                    } else if (audio) {
                        console.log(`🎵 [${userId}] Audio recibido de ${sender}`);
                        await procesarAudioWhatsApp(msg, sock, sender);
                        return;
                    }
                }
            }
        });

        return sock;
    } catch (error) {
        console.error(`❌ Error creando sesión ${userId}:`, error);
        sessionStates[userId] = 'error';
        throw error;
    }
}

async function processWithGroq(transcripcion, sender) {
    try {
        const prompt = `
        Analiza el siguiente texto de pedido y extrae un JSON con la información de los productos.

        Instrucciones:

        1. Devuelve únicamente un JSON válido con esta estructura EXACTA:
        {
        "productos": [
            {"nombre": "nombre del producto", "cantidad": numero}
        ]
        }

        2. Reglas importantes:
        - no simplifiques los nombres de los productos, ponlos tal cual aparecen.
        - Si un producto aparece varias veces suma las cantidades.
        - Corrige errores ortográficos evidentes en los nombres de productos.
        - Respeta las palabras clave tal como aparecen: si dice "barril" no lo cambies y si dice "lata" tampoco.
        - Si el producto indica que es sin alcohol cambia en el texto 0.0 por sin alcohol.
        - Para "tercios" o "quintos" convierte a decimal: 1/3 → 0,33, 1/5 → 0,2.
        - Si no se indica cantidad explícita, asume que es 1.
        - Solo incluye los productos listados en el texto; no agregues otros.

        No agregues explicaciones, solo devuelve el JSON.

        Texto del pedido:
        "${transcripcion}"
    `;

        let completion = await groqClient.chat.completions.create({
            model: "llama-3.1-8b-instant",
            messages: [{ role: "user", content: prompt }],
            temperature: 0
        });

        // Poner el texto en minúsculas para facilitar reemplazos
        completion.choices[0].message.content = completion.choices[0].message.content.toLowerCase();

        // Aplicar filtros
        completion.choices[0].message.content = completion.choices[0].message.content.replaceAll("barra", "33CL");
        completion.choices[0].message.content = completion.choices[0].message.content.replaceAll("botellín", "estrella galicia");
        completion.choices[0].message.content = completion.choices[0].message.content.replaceAll("eg", "estrella galicia");
        completion.choices[0].message.content = completion.choices[0].message.content.replaceAll("sin alcohol", "0.0");
        completion.choices[0].message.content = completion.choices[0].message.content.replaceAll("sin", "0.0");
        completion.choices[0].message.content = completion.choices[0].message.content.replaceAll("quinto", "20CL");
        completion.choices[0].message.content = completion.choices[0].message.content.replaceAll("tercio", "33CL");
        let resultado = completion.choices[0].message.content.trim();
        let pedidoData = JSON.parse(resultado);
        pedidoData.textoOriginal = transcripcion;

        console.log('✅ Pedido procesado con Groq:', pedidoData);

        const resumen = await guardarPedidoEnFirebase(pedidoData, sender);
        return resumen;

    } catch (error) {
        console.error('❌ Error procesando con Groq:', error);
        return `Por favor, vuelva a enviar el pedido. Hubo un error de red.`;
    }
}

async function leerTextoDesdeImagen(imagePath) {
    try {
        // Verifica que el archivo existe
        if (!fs.existsSync(imagePath)) {
            throw new Error(`El archivo ${imagePath} no existe`);
        }

        // Lee el archivo como buffer
        const imageBuffer = fs.readFileSync(imagePath);

        // Llama al API con el buffer directamente
        const resultado = await computerVisionClient.readInStream(imageBuffer, {
            language: "es"
        });

        // El API es asincrónico: hay que esperar resultados
        const operationId = resultado.operationLocation.split("/").slice(-1)[0];

        console.log("Procesando imagen... ID de operación:", operationId);

        let lectura;
        let intentos = 0;
        const maxIntentos = 30; // Máximo 30 segundos de espera

        while (intentos < maxIntentos) {
            lectura = await computerVisionClient.getReadResult(operationId);

            console.log(`Intento ${intentos + 1}: Estado = ${lectura.status}`);

            if (lectura.status === "succeeded" || lectura.status === "failed") {
                break;
            }

            await new Promise(r => setTimeout(r, 1000));
            intentos++;
        }

        if (lectura.status === "succeeded") {
            console.log("\n--- TEXTO EXTRAÍDO ---");
            let textoCompleto = "";

            for (const page of lectura.analyzeResult.readResults) {
                console.log(`\nPágina ${page.page}:`);
                for (const line of page.lines) {
                    console.log(line.text);
                    textoCompleto += line.text + "\n";
                }
            }

            return textoCompleto; // Devolver el texto extraído

        } else if (lectura.status === "failed") {
            console.error("❌ El procesamiento de la imagen falló");
            throw new Error("El procesamiento de la imagen falló");
        } else {
            console.error("⏰ Tiempo de espera agotado");
            throw new Error("Tiempo de espera agotado");
        }

    } catch (err) {
        console.error("❌ Error leyendo texto:", err.message);

        // Información adicional para debugging
        if (err.response) {
            console.error("Respuesta del servidor:", err.response.status);
            console.error("Detalles:", err.response.data);
        }
        throw err; // Lanzar el error
    }
}

async function transcribirAudio(audioPath) {
    try {
        console.log(`🎵 Iniciando transcripción de audio: ${audioPath}`);

        // Verificar que el archivo existe
        if (!fs.existsSync(audioPath)) {
            throw new Error(`El archivo de audio ${audioPath} no existe`);
        }

        let wavPath = audioPath;

        // Solo convertir si NO es WAV
        if (!audioPath.toLowerCase().endsWith('.wav')) {
            wavPath = audioPath.replace(/\.[^/.]+$/, '.wav');

            await new Promise((resolve, reject) => {
                ffmpeg(audioPath)
                    .toFormat('wav')
                    .audioFrequency(16000)
                    .audioChannels(1)
                    .on('end', () => {
                        console.log('✅ Conversión a WAV completada');
                        resolve();
                    })
                    .on('error', (err) => {
                        console.error('❌ Error convirtiendo audio:', err);
                        reject(err);
                    })
                    .save(wavPath);
            });
        } else {
            console.log('📁 El archivo ya está en formato WAV, se omite la conversión');
        }

        // Leer el archivo de audio convertido
        const audioBytes = fs.readFileSync(wavPath).toString('base64');

        // Configuración para la API de Speech-to-Text
        const request = {
            audio: {
                content: audioBytes,
            },
            config: {
                encoding: 'LINEAR16', // Formato WAV
                sampleRateHertz: 16000,
                languageCode: 'es-ES', // Español de España
                alternativeLanguageCodes: ['es-MX', 'es-AR', 'es-CO'], // Otros dialectos del español
                enableAutomaticPunctuation: true,
                enableWordTimeOffsets: false,
                model: 'latest_long', // Modelo optimizado para audio largo
            },
        };

        // Realizar la transcripción
        console.log('🔄 Enviando audio a Google Speech-to-Text...');
        const [response] = await speechClient.recognize(request);

        if (!response.results || response.results.length === 0) {
            console.log('⚠️ No se pudo transcribir el audio');
            return 'No se pudo transcribir el audio. Intenta hablar más claro.';
        }

        // Extraer el texto transcrito
        const transcripcion = response.results
            .map(result => result.alternatives[0].transcript)
            .join(' ');

        console.log(`✅ Transcripción completada: "${transcripcion}"`);

        // Limpiar archivos temporales
        try {
            //if (fs.existsSync(wavPath)) {
            //  fs.unlinkSync(wavPath);
            //    console.log('🗑️ Archivo WAV temporal eliminado');
            //}
        } catch (cleanupError) {
            console.warn('⚠️ No se pudo eliminar archivo temporal:', cleanupError.message);
        }

        return transcripcion;

    } catch (error) {
        console.error('❌ Error transcribiendo audio:', error);
        throw new Error(`Error en la transcripción: ${error.message}`);
    }
}

async function procesarAudioWhatsApp(msg, sock, sender) {
    try {
        console.log(`🎵 Procesando audio de WhatsApp de ${sender}`);

        // Descargar el mensaje de audio
        const buffer = await downloadMediaMessage(msg, "buffer");

        // Crear directorio temporal si no existe
        const tempDir = './temp_audio/';
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }

        // Guardar el audio con timestamp único
        const timestamp = Date.now();
        const audioPath = path.join(tempDir, `audio_${timestamp}.ogg`);
        fs.writeFileSync(audioPath, buffer);

        console.log(`💾 Audio guardado temporalmente en: ${audioPath}`);

        // Transcribir el audio
        const transcripcion = await transcribirAudio(audioPath);

        // Procesar la transcripción como si fuera texto
        const respuesta = await processWithGroq(transcripcion, sender);

        // Enviar respuesta al cliente
        await sock.sendMessage(sender, {
            text: `🎵 *Audio transcrito:* "${transcripcion}"\n\n${respuesta}`
        });

        // Limpiar archivo temporal
        setTimeout(() => {
            if (fs.existsSync(audioPath)) {
                fs.unlinkSync(audioPath);
                console.log(`🗑️ Archivo de audio temporal eliminado: ${audioPath}`);
            }
        }, 5000);

        return transcripcion;

    } catch (error) {
        console.error('❌ Error procesando audio de WhatsApp:', error);

        // Enviar mensaje de error al usuario
        await sock.sendMessage(sender, {
            text: `❌ No pude procesar tu audio. Por favor, intenta enviar el mensaje como texto o asegúrate de que el audio sea claro.`
        });

        return null;
    }
}

async function verificarConfiguracionEmail() {
    try {
        await transporter.verify();
        console.log('✅ Configuración de email verificada correctamente');
        return true;
    } catch (error) {
        console.error('❌ Error en la configuración de email:', error);
        return false;
    }
}

async function generarYEnviarExcelPedido(pedidoData, clienteInfo) {
    try {
        console.log('📊 Generando archivo Excel para el pedido...');

        // Crear directorio de pedidos si no existe
        const pedidosDir = './pedidos_excel/';
        if (!fs.existsSync(pedidosDir)) {
            fs.mkdirSync(pedidosDir, { recursive: true });
        }

        // Obtener fecha actual para el nombre del archivo
        const fechaActual = new Date();
        const fechaFormateada = fechaActual.toISOString().split('T')[0]; // YYYY-MM-DD
        const horaFormateada = fechaActual.toTimeString().split(' ')[0].replace(/:/g, '-'); // HH-MM-SS

        // Nombre del archivo
        const nombreCliente = clienteInfo.nombre.replace(/[^a-zA-Z0-9]/g, '_'); // Limpiar caracteres especiales
        const nombreArchivo = `Pedido_${fechaFormateada}_${nombreCliente}_${horaFormateada}.xlsx`;
        const rutaArchivo = path.join(pedidosDir, nombreArchivo);

        // Preparar datos para el Excel
        const datosExcel = [];

        // Agregar encabezado con información del pedido
        datosExcel.push(['PEDIDO CONFIRMADO']);
        datosExcel.push(['']);
        datosExcel.push(['Fecha:', fechaActual.toLocaleString('es-ES')]);
        datosExcel.push(['Cliente:', clienteInfo.nombre]);
        datosExcel.push(['Teléfono:', clienteInfo.telefono]);
        datosExcel.push(['Email:', clienteInfo.email]);
        datosExcel.push(['Dirección:', clienteInfo.direccion]);
        datosExcel.push(['']);
        datosExcel.push(['PRODUCTOS DEL PEDIDO']);
        datosExcel.push(['']);

        // Encabezados de los productos
        datosExcel.push(['Referencia', 'Cantidad', 'Descripcion']);

        // Agregar productos
        let totalPedido = 0;
        pedidoData.productos.forEach((producto, index) => {
            const referencia = producto.id || `REF-${index + 1}`;
            const cantidad = producto.cantidad;
            const nombre = producto.nombre;

            datosExcel.push([
                referencia,
                cantidad,
                nombre
            ]);

            totalPedido += subtotal;
        });

        // Crear libro de Excel
        const workbook = XLSX.utils.book_new();
        const worksheet = XLSX.utils.aoa_to_sheet(datosExcel);

        // Configurar ancho de columnas
        const columnWidths = [
            { wch: 15 }, // Referencia
            { wch: 10 }, // Cantidad
            { wch: 30 }, // Nombre del Producto
            { wch: 15 }, // Precio Unitario
            { wch: 15 }  // Subtotal
        ];
        worksheet['!cols'] = columnWidths;

        // Agregar hoja al libro
        XLSX.utils.book_append_sheet(workbook, worksheet, 'Pedido');

        // Guardar archivo
        XLSX.writeFile(workbook, rutaArchivo);

        console.log(`✅ Archivo Excel generado: ${rutaArchivo}`);

        // Enviar por correo electrónico
        const resultadoEmail = await enviarExcelPorCorreo(rutaArchivo, nombreArchivo, pedidoData, clienteInfo);

        return {
            success: true,
            filePath: rutaArchivo,
            fileName: nombreArchivo,
            emailEnviado: resultadoEmail.success,
            emailError: resultadoEmail.error || null,
            destinatario: resultadoEmail.destinatario
        };

    } catch (error) {
        console.error('❌ Error generando archivo Excel:', error);
        return {
            success: false,
            error: error.message
        };
    }
}

async function enviarExcelPorCorreo(rutaArchivo, nombreArchivo, pedidoData, clienteInfo) {
    try {
        if (!clienteInfo.email) {
            throw new Error('El cliente no tiene email registrado');
        }

        // Configurar transporte de Nodemailer (SMTP)
        const transporter = nodemailer.createTransport({
            host: 'smtp.gmail.com', // Cambia por tu servidor SMTP
            port: 587,                    // O 465 para SSL
            secure: false,                // true si usas SSL
            auth: {
                user: 'andercruzgutierrezz@gmail.com',
                pass: 'ewtxipbrwdtjnbiz'
            }
        });

        // Leer archivo Excel
        const fileContent = fs.readFileSync(rutaArchivo);

        // Configurar correo
        const mailOptions = {
            from: '"Pedidos Exlan" <andercruzgutierrezz@gmail.com>',
            //to: clienteInfo.email,
            to: "ander.cruz@alumni.mondragon.edu",
            subject: `Pedido Confirmado - ${clienteInfo.nombre}`,
            text: `Hola,\n\nAdjunto encontrarás el Excel con los detalles del cliente ${clienteInfo.nombre}.`,
            attachments: [
                {
                    filename: nombreArchivo,
                    content: fileContent,
                    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
                }
            ]
        };

        // Enviar correo
        const info = await transporter.sendMail(mailOptions);
        console.log(`📧 Correo enviado a ${clienteInfo.email}: ${info.messageId}`);

        return {
            success: true,
            destinatario: clienteInfo.email,
            error: null
        };

    } catch (error) {
        console.error(`❌ Error enviando correo a ${clienteInfo.email}:`, error);
        return {
            success: false,
            destinatario: clienteInfo.email || null,
            error: error.message
        };
    }
}

// Endpoint para procesar audio y añadir productos a la carta
app.post('/process-audio-products', upload.single('audio'), async (req, res) => {
    try {
        const { clientId, cartaId } = req.body;
        const audioFile = req.file;

        // Validaciones
        if (!clientId || !cartaId) {
            return res.status(400).json({
                success: false,
                error: 'Faltan campos requeridos: clientId, cartaId'
            });
        }

        if (!audioFile) {
            return res.status(400).json({
                success: false,
                error: 'No se subió ningún archivo de audio'
            });
        }

        // Verificar que el cliente y la carta existen
        const cartaRef = db.collection('clientes')
            .doc(clientId)
            .collection('cartas')
            .doc(cartaId);
            
        const cartaDoc = await cartaRef.get();
        
        if (!cartaDoc.exists) {
            // Limpiar archivo temporal
            fs.unlinkSync(audioFile.path);
            return res.status(404).json({
                success: false,
                error: `Carta ${cartaId} no encontrada para el cliente ${clientId}`
            });
        }

        console.log(`🎵 Procesando audio para cliente ${clientId}, carta: ${cartaId}`);

        // Transcribir el audio
        const transcripcion = await transcribirAudio(audioFile.path);
        
        if (!transcripcion || transcripcion.includes('No se pudo transcribir')) {
            // Limpiar archivo temporal
            fs.unlinkSync(audioFile.path);
            return res.status(400).json({
                success: false,
                error: 'No se pudo transcribir el audio correctamente'
            });
        }

        console.log(`✅ Audio transcrito: "${transcripcion}"`);

        // Procesar con Groq para extraer productos
        const productosData = await procesarProductosConGroq(transcripcion);
        
        if (!productosData.success) {
            // Limpiar archivo temporal
            fs.unlinkSync(audioFile.path);
            return res.status(400).json({
                success: false,
                error: `Error procesando productos: ${productosData.error}`
            });
        }

        // Añadir productos a la carta
        const resultadoFirebase = await añadirReferenciasACarta(
            cartaRef, 
            productosData.productos
        );

        // Limpiar archivo temporal
        setTimeout(() => {
            if (fs.existsSync(audioFile.path)) {
                fs.unlinkSync(audioFile.path);
                console.log(`🗑️ Archivo de audio temporal eliminado: ${audioFile.path}`);
            }
        }, 5000);

        // Respuesta exitosa
        res.json({
            success: true,
            message: 'Audio procesado y referencias añadidas correctamente',
            data: {
                clientId,
                cartaId,
                transcripcion,
                productosExtraidos: productosData.productos.length,
                referenciasAñadidas: resultadoFirebase.añadidos,
                referenciasConError: resultadoFirebase.errores,
                productos: productosData.productos
            }
        });

    } catch (error) {
        console.error('❌ Error procesando audio y productos:', error);
        
        // Limpiar archivo en caso de error
        if (req.file && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }

        res.status(500).json({
            success: false,
            error: 'Error interno del servidor',
            details: error.message
        });
    }
});

// Función para procesar productos con Groq
async function procesarProductosConGroq(transcripcion) {
    try {
        const prompt = `
Analiza el siguiente texto donde se mencionan productos de una carta de bar/restaurante y extrae la información en formato JSON.

Instrucciones:

1. Devuelve únicamente un JSON válido con esta estructura EXACTA:
{
  "productos": [
    {
      "categoria": "categoria del producto (ej: bebidas, tapas, principales, postres, etc.)",
      "nombre": "nombre resumido del producto",
      "descripcion": "descripción breve del producto basada en lo mencionado",
      "precio": numero_decimal
    }
  ]
}

2. Reglas importantes:
- Extrae TODOS los productos mencionados en el texto
- Si no se menciona precio, pon 0
- Las categorías deben ser coherentes (bebidas, tapas, platos principales, postres, etc.)
- La descripción debe ser breve pero informativa
- Corrige errores ortográficos evidentes
- Si un producto se menciona varias veces, inclúyelo solo una vez
- No inventes información que no esté en el texto

3. Ejemplos de categorías válidas:
- "bebidas" (cervezas, vinos, refrescos, cafés)
- "tapas" (pinchos, aperitivos)
- "principales" (platos principales, carnes, pescados)
- "postres" (dulces, helados)
- "entrantes" (primeros platos)

No agregues explicaciones, solo devuelve el JSON.

Texto a analizar:
"${transcripcion}"
        `;

        const completion = await groqClient.chat.completions.create({
            model: "llama-3.1-8b-instant",
            messages: [{ role: "user", content: prompt }],
            temperature: 0.3
        });

        let resultado = completion.choices[0].message.content.trim();
        
        // Limpiar el resultado por si viene con markdown
        resultado = resultado.replace(/```json\n?|\n?```/g, '').trim();
        
        const productosData = JSON.parse(resultado);

        // Validar estructura
        if (!productosData.productos || !Array.isArray(productosData.productos)) {
            throw new Error('Formato de respuesta inválido: falta array de productos');
        }

        // Validar cada producto
        const productosValidos = productosData.productos.filter(producto => {
            return producto.categoria && 
                   producto.nombre && 
                   producto.descripcion !== undefined &&
                   typeof producto.precio === 'number';
        });

        console.log(`✅ ${productosValidos.length} productos extraídos correctamente con Groq`);

        return {
            success: true,
            productos: productosValidos
        };

    } catch (error) {
        console.error('❌ Error procesando productos con Groq:', error);
        return {
            success: false,
            error: error.message
        };
    }
}

// Función para añadir referencias a la carta en Firebase
async function añadirReferenciasACarta(cartaRef, productos) {
    try {
        console.log(`📝 Añadiendo ${productos.length} referencias a la carta`);
        
        // Obtener las referencias actuales de la carta
        const cartaDoc = await cartaRef.get();
        const datosActuales = cartaDoc.data();
        const referenciasActuales = datosActuales.referencias || [];

        console.log(`📋 Referencias actuales en la carta: ${referenciasActuales.length}`);

        let añadidos = 0;
        const errores = [];
        const nuevasReferencias = [...referenciasActuales];

        for (const producto of productos) {
            try {
                // Crear la referencia con la estructura que necesitas
                const nuevaReferencia = {
                    // capitalize la primera letra de la categoría
                    categoria: producto.categoria.charAt(0).toUpperCase() + producto.categoria.slice(1).toLowerCase(),
                    nombre: producto.nombre,
                    descripcion: producto.descripcion,
                    precio: producto.precio,
                    fechaCreacion: new Date().toISOString(), // Usamos ISO string ya que no podemos usar FieldValue en array
                    activo: true,
                    id: db.collection('temp').doc().id // Generar ID único
                };

                // Verificar si ya existe una referencia con el mismo nombre (evitar duplicados)
                const existeReferencia = nuevasReferencias.find(ref => 
                    ref.nombre && ref.nombre.toLowerCase() === producto.nombre.toLowerCase()
                );

                if (!existeReferencia) {
                    nuevasReferencias.push(nuevaReferencia);
                    añadidos++;
                    console.log(`➕ Referencia preparada: ${producto.nombre} (${producto.categoria})`);
                } else {
                    console.log(`⚠️ Referencia duplicada omitida: ${producto.nombre}`);
                    errores.push({
                        producto: producto.nombre,
                        error: 'Ya existe una referencia con este nombre'
                    });
                }

            } catch (error) {
                console.error(`❌ Error preparando referencia ${producto.nombre}:`, error);
                errores.push({
                    producto: producto.nombre,
                    error: error.message
                });
            }
        }

        // Actualizar la carta con las nuevas referencias
        await cartaRef.update({
            referencias: nuevasReferencias
        });

        console.log(`✅ ${añadidos} referencias añadidas correctamente a la carta`);

        return {
            success: true,
            añadidos,
            errores,
            totalReferencias: nuevasReferencias.length
        };

    } catch (error) {
        console.error('❌ Error añadiendo referencias a Firebase:', error);
        throw new Error(`Error guardando referencias en Firebase: ${error.message}`);
    }
}

// Endpoint adicional para obtener cartas de un cliente
app.get('/client-cartas/:clientId', async (req, res) => {
    try {
        const { clientId } = req.params;

        // Verificar que el cliente existe
        const clienteRef = db.collection('clientes').doc(clientId);
        const clienteDoc = await clienteRef.get();
        
        if (!clienteDoc.exists) {
            return res.status(404).json({
                success: false,
                error: `Cliente ${clientId} no encontrado`
            });
        }

        // Obtener cartas del cliente
        const cartasSnapshot = await clienteRef.collection('cartas').get();
        const cartas = [];

        cartasSnapshot.forEach(doc => {
            cartas.push({
                id: doc.id,
                ...doc.data()
            });
        });

        res.json({
            success: true,
            clientId,
            cartas,
            totalCartas: cartas.length
        });

    } catch (error) {
        console.error('❌ Error obteniendo cartas del cliente:', error);
        res.status(500).json({
            success: false,
            error: 'Error obteniendo cartas',
            details: error.message
        });
    }
});

// Endpoint para obtener productos de una carta específica
app.get('/client-carta-productos/:clientId/:cartaId', async (req, res) => {
    try {
        const { clientId, cartaId } = req.params;

        // Obtener productos de la carta
        const productosSnapshot = await db.collection('clientes')
            .doc(clientId)
            .collection('cartas')
            .doc(cartaId)
            .collection('productos')
            .get();

        const productos = [];
        productosSnapshot.forEach(doc => {
            productos.push({
                id: doc.id,
                ...doc.data()
            });
        });

        res.json({
            success: true,
            clientId,
            cartaId,
            productos,
            totalProductos: productos.length
        });

    } catch (error) {
        console.error('❌ Error obteniendo productos de la carta:', error);
        res.status(500).json({
            success: false,
            error: 'Error obteniendo productos',
            details: error.message
        });
    }
});

// ==== INICIALIZACIÓN ====
(async () => {
    try {
        await cargarProductos();
        await cargarProductosOtros();

        // Verificar configuración de email
        await verificarConfiguracionEmail();

        // Iniciar servidor Express
        app.listen(PORT, () => {
            console.log(`🚀 Servidor HTTP iniciado en puerto ${PORT}`);
            console.log(`📡 Endpoints disponibles:`);
            console.log(`   POST /create-session - Crear nueva sesión de WhatsApp`);
            console.log(`   GET  /session-qr/:sessionName - Obtener QR de una sesión`);
            console.log(`   DELETE /session/:sessionName - Eliminar sesión`);
            console.log(`   POST /upload-and-send - Subir y enviar imagen`);
            console.log(`   POST /send-message - Enviar mensaje de texto`);
            console.log(`   GET  /sessions - Ver estado de sesiones`);
        });

        console.log('🚀 Bot de WhatsApp con sesiones dinámicas iniciado correctamente');

    } catch (error) {
        console.error('❌ Error inicializando el bot:', error);
    }
})();