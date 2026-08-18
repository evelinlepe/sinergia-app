// db.js — almacenamiento simple en un archivo JSON.
// No usa dependencias nativas (nada que compilar), así que funciona
// en cualquier lado con solo tener Node.js instalado.

const fs = require('fs');
const path = require('path');
const { hashPassword } = require('./auth');

const DATA_FILE = path.join(__dirname, 'data', 'db.json');

function nextId(arr) {
  return arr.reduce((max, item) => Math.max(max, item.id), 0) + 1;
}

function emptyDb() {
  return {
    users: [],
    suppliers: [],
    products: [],
    sales: [],
    movements: [], // ingresos/egresos de stock (mercadería)
    expenses: [], // gastos generales (alquiler, servicios, etc.)
    clients: [], // clientas de cuenta corriente
    ccCharges: [], // prendas que se llevó una clienta a cuenta
    ccPayments: [] // pagos parciales que va haciendo la clienta
  };
}

function load() {
  if (!fs.existsSync(DATA_FILE)) {
    const db = emptyDb();
    seed(db);
    save(db);
    return db;
  }
  const raw = fs.readFileSync(DATA_FILE, 'utf-8');
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error('data/db.json está corrupto, se crea uno nuevo. Error:', e.message);
    const db = emptyDb();
    seed(db);
    save(db);
    return db;
  }
}

function save(db) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), 'utf-8');
}

function seed(db) {
  // Usuario dueña por defecto. CAMBIAR la contraseña después del primer login.
  const passwordHash = hashPassword('sinergia2026');
  db.users.push({
    id: nextId(db.users),
    username: 'duena',
    passwordHash,
    role: 'duena',
    name: 'Dueña'
  });
}

module.exports = { load, save, nextId, DATA_FILE };
