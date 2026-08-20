// server.js — App de gestión para "Sinergia" (indumentaria deportiva urbana)
// Escrito SOLO con módulos incluidos en Node.js (http, fs, crypto, etc.)
// para que no haga falta "npm install" ni conexión a internet para correrla.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./db');
const { hashPassword, verifyPassword } = require('./auth');

let db = store.load();
function persist() {
  store.save(db);
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// Convierte una fecha elegida a mano (ej. "2026-08-10") a un ISO válido.
// Si viene solo la fecha, se fija el mediodía para evitar que, por la zona
// horaria, la venta termine mostrándose un día antes o después.
function normalizeDateInput(dateStr) {
  if (!dateStr) return new Date().toISOString();
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return new Date(dateStr + 'T12:00:00').toISOString();
  }
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

function publicUser(u) {
  return { id: u.id, username: u.username, role: u.role, name: u.name };
}

function sanitizeProduct(p, role) {
  if (role === 'duena') return p;
  const { costPrice, supplierId, ...rest } = p;
  return rest;
}

function clientBalance(clientId) {
  const charges = db.ccCharges.filter((c) => c.clientId === clientId).reduce((s, c) => s + c.amount, 0);
  const payments = db.ccPayments.filter((p) => p.clientId === clientId).reduce((s, p) => s + p.amount, 0);
  return round2(charges - payments);
}

// ================= SESIONES =================
const SESSION_COOKIE = 'sid';
const SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12hs
const sessions = new Map();

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}

function createSession(userId) {
  const id = crypto.randomBytes(24).toString('hex');
  sessions.set(id, { userId, expires: Date.now() + SESSION_TTL_MS });
  return id;
}

function getSession(req) {
  const sid = parseCookies(req)[SESSION_COOKIE];
  if (!sid) return null;
  const s = sessions.get(sid);
  if (!s || s.expires < Date.now()) {
    sessions.delete(sid);
    return null;
  }
  s.expires = Date.now() + SESSION_TTL_MS; // renovar
  return { id: sid, ...s };
}

function currentUser(req) {
  const s = getSession(req);
  if (!s) return null;
  const u = db.users.find((x) => x.id === s.userId);
  return u ? publicUser(u) : null;
}

function setSessionCookie(res, sid) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${sid}; HttpOnly; Path=/; Max-Age=${SESSION_TTL_MS / 1000}; SameSite=Lax`);
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
}

// ================= HELPERS HTTP =================
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let data = '';
    let tooBig = false;
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 2_000_000) {
        tooBig = true;
        req.destroy();
      }
    });
    req.on('end', () => {
      if (tooBig || !data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

function findOr404(ctx, arr, id, label) {
  const item = arr.find((x) => x.id === Number(id));
  if (!item) {
    sendJson(ctx.res, 404, { error: `${label} no encontrado` });
    return null;
  }
  return item;
}

// ================= ROUTER =================
const routes = [];
function route(method, pattern, opts, handler) {
  if (typeof opts === 'function') {
    handler = opts;
    opts = {};
  }
  const paramNames = [];
  const regexStr = pattern.replace(/:[^/]+/g, (m) => {
    paramNames.push(m.slice(1));
    return '([^/]+)';
  });
  const regex = new RegExp('^' + regexStr + '$');
  routes.push({ method, regex, paramNames, opts, handler });
}

// ---------- AUTH ----------
route('POST', '/api/login', async (ctx) => {
  const { username, password } = ctx.body || {};
  const user = db.users.find((u) => u.username === String(username || '').trim().toLowerCase());
  if (!user || !verifyPassword(password || '', user.passwordHash)) {
    return sendJson(ctx.res, 401, { error: 'Usuario o contraseña incorrectos' });
  }
  const sid = createSession(user.id);
  setSessionCookie(ctx.res, sid);
  sendJson(ctx.res, 200, { user: publicUser(user) });
});

route('POST', '/api/logout', (ctx) => {
  const sid = parseCookies(ctx.req)[SESSION_COOKIE];
  if (sid) sessions.delete(sid);
  clearSessionCookie(ctx.res);
  sendJson(ctx.res, 200, { ok: true });
});

route('GET', '/api/me', (ctx) => {
  sendJson(ctx.res, 200, { user: ctx.user || null });
});

route('POST', '/api/change-password', { auth: true }, (ctx) => {
  const { currentPassword, newPassword } = ctx.body || {};
  const user = db.users.find((u) => u.id === ctx.user.id);
  if (!verifyPassword(currentPassword || '', user.passwordHash)) {
    return sendJson(ctx.res, 400, { error: 'La contraseña actual no es correcta' });
  }
  if (!newPassword || newPassword.length < 6) {
    return sendJson(ctx.res, 400, { error: 'La nueva contraseña debe tener al menos 6 caracteres' });
  }
  user.passwordHash = hashPassword(newPassword);
  persist();
  sendJson(ctx.res, 200, { ok: true });
});

// ---------- USUARIAS (solo dueña) ----------
route('GET', '/api/users', { owner: true }, (ctx) => {
  sendJson(ctx.res, 200, db.users.map(publicUser));
});

route('POST', '/api/users', { owner: true }, (ctx) => {
  const { username, password, name, role } = ctx.body || {};
  if (!username || !password || !name || !['duena', 'empleada'].includes(role)) {
    return sendJson(ctx.res, 400, { error: 'Faltan datos o el rol no es válido' });
  }
  const uname = String(username).trim().toLowerCase();
  if (db.users.some((u) => u.username === uname)) {
    return sendJson(ctx.res, 400, { error: 'Ese nombre de usuario ya existe' });
  }
  const user = { id: store.nextId(db.users), username: uname, passwordHash: hashPassword(password), role, name };
  db.users.push(user);
  persist();
  sendJson(ctx.res, 201, publicUser(user));
});

route('PUT', '/api/users/:id', { owner: true }, (ctx) => {
  const user = findOr404(ctx, db.users, ctx.params.id, 'Usuario');
  if (!user) return;
  const { name, role, password } = ctx.body || {};
  if (name) user.name = name;
  if (role && ['duena', 'empleada'].includes(role)) user.role = role;
  if (password) {
    if (password.length < 6) return sendJson(ctx.res, 400, { error: 'La contraseña debe tener al menos 6 caracteres' });
    user.passwordHash = hashPassword(password);
  }
  persist();
  sendJson(ctx.res, 200, publicUser(user));
});

route('DELETE', '/api/users/:id', { owner: true }, (ctx) => {
  if (Number(ctx.params.id) === ctx.user.id) {
    return sendJson(ctx.res, 400, { error: 'No podés eliminar tu propio usuario' });
  }
  const idx = db.users.findIndex((u) => u.id === Number(ctx.params.id));
  if (idx === -1) return sendJson(ctx.res, 404, { error: 'Usuario no encontrado' });
  db.users.splice(idx, 1);
  persist();
  sendJson(ctx.res, 200, { ok: true });
});

// ---------- PROVEEDORES (solo dueña) ----------
route('GET', '/api/suppliers', { owner: true }, (ctx) => sendJson(ctx.res, 200, db.suppliers));

route('POST', '/api/suppliers', { owner: true }, (ctx) => {
  const { name, phone, notes } = ctx.body || {};
  if (!name) return sendJson(ctx.res, 400, { error: 'Falta el nombre del proveedor' });
  const supplier = { id: store.nextId(db.suppliers), name, phone: phone || '', notes: notes || '' };
  db.suppliers.push(supplier);
  persist();
  sendJson(ctx.res, 201, supplier);
});

route('PUT', '/api/suppliers/:id', { owner: true }, (ctx) => {
  const supplier = findOr404(ctx, db.suppliers, ctx.params.id, 'Proveedor');
  if (!supplier) return;
  Object.assign(supplier, ctx.body || {});
  persist();
  sendJson(ctx.res, 200, supplier);
});

route('DELETE', '/api/suppliers/:id', { owner: true }, (ctx) => {
  const idx = db.suppliers.findIndex((s) => s.id === Number(ctx.params.id));
  if (idx === -1) return sendJson(ctx.res, 404, { error: 'Proveedor no encontrado' });
  db.suppliers.splice(idx, 1);
  persist();
  sendJson(ctx.res, 200, { ok: true });
});

// ---------- PRODUCTOS / STOCK ----------
route('GET', '/api/products', { auth: true }, (ctx) => {
  sendJson(ctx.res, 200, db.products.map((p) => sanitizeProduct(p, ctx.user.role)));
});

route('GET', '/api/products/low-stock', { auth: true }, (ctx) => {
  const low = db.products.filter((p) => p.stock <= p.lowStockThreshold);
  sendJson(ctx.res, 200, low.map((p) => sanitizeProduct(p, ctx.user.role)));
});

route('POST', '/api/products', { owner: true }, (ctx) => {
  const { name, category, size, piece, color, costPrice, salePrice, stock, lowStockThreshold, supplierId } = ctx.body || {};
  if (!name || salePrice == null || salePrice === '') {
    return sendJson(ctx.res, 400, { error: 'Faltan datos obligatorios (nombre y precio de venta)' });
  }
  const product = {
    id: store.nextId(db.products),
    name,
    category: category || '',
    size: size || '',
    piece: piece || '',
    color: color || '',
    costPrice: Number(costPrice) || 0,
    salePrice: Number(salePrice),
    stock: Number(stock) || 0,
    lowStockThreshold: Number(lowStockThreshold) || 3,
    supplierId: supplierId ? Number(supplierId) : null,
    createdAt: new Date().toISOString()
  };
  db.products.push(product);
  persist();
  sendJson(ctx.res, 201, product);
});

// Carga múltiple: crea varias prendas de una sola vez que comparten nombre
// base, categoría, color, precios y proveedor. Cada fila puede tener su
// propia "pieza" (ej: Top, Campera, Legging) y/o su propio "talle" (ej: S,
// M, L) de forma independiente, para cubrir tanto varios talles de la misma
// prenda como las piezas de un conjunto —cada una con sus propios talles si
// hace falta—, y cada una se vende y descuenta del stock por separado.
route('POST', '/api/products/batch', { owner: true }, (ctx) => {
  const { name, category, color, costPrice, salePrice, supplierId, lowStockThreshold, variants } = ctx.body || {};
  if (!name) return sendJson(ctx.res, 400, { error: 'Falta el nombre base de la prenda' });
  if (!Array.isArray(variants) || variants.length === 0) {
    return sendJson(ctx.res, 400, { error: 'Agregá al menos una fila (talle y/o pieza)' });
  }
  const baseSalePrice = salePrice != null && salePrice !== '' ? Number(salePrice) : null;
  for (const v of variants) {
    const hasOwnPrice = v.salePrice != null && v.salePrice !== '';
    if (baseSalePrice == null && !hasOwnPrice) {
      return sendJson(ctx.res, 400, { error: 'Falta el precio de venta (general o por fila)' });
    }
  }

  const created = [];
  for (const v of variants) {
    const piece = (v.piece || '').trim();
    const size = (v.size || '').trim();
    const suffix = [piece, size].filter(Boolean).join(' - ');
    const product = {
      id: store.nextId(db.products),
      name: suffix ? `${name} - ${suffix}` : name,
      category: category || '',
      size,
      piece,
      color: color || '',
      costPrice: Number(costPrice) || 0,
      salePrice: v.salePrice != null && v.salePrice !== '' ? Number(v.salePrice) : baseSalePrice,
      stock: Number(v.stock) || 0,
      lowStockThreshold: Number(lowStockThreshold) || 3,
      supplierId: supplierId ? Number(supplierId) : null,
      setName: name,
      createdAt: new Date().toISOString()
    };
    db.products.push(product);
    created.push(product);
  }
  persist();
  sendJson(ctx.res, 201, created);
});

route('PUT', '/api/products/:id', { owner: true }, (ctx) => {
  const product = findOr404(ctx, db.products, ctx.params.id, 'Producto');
  if (!product) return;
  const fields = ['name', 'category', 'size', 'piece', 'color', 'costPrice', 'salePrice', 'stock', 'lowStockThreshold', 'supplierId'];
  for (const f of fields) {
    if (ctx.body[f] !== undefined && ctx.body[f] !== '') {
      product[f] = ['costPrice', 'salePrice', 'stock', 'lowStockThreshold'].includes(f)
        ? Number(ctx.body[f])
        : f === 'supplierId'
        ? Number(ctx.body[f]) || null
        : ctx.body[f];
    }
  }
  persist();
  sendJson(ctx.res, 200, product);
});

route('DELETE', '/api/products/:id', { owner: true }, (ctx) => {
  const idx = db.products.findIndex((p) => p.id === Number(ctx.params.id));
  if (idx === -1) return sendJson(ctx.res, 404, { error: 'Producto no encontrado' });
  db.products.splice(idx, 1);
  persist();
  sendJson(ctx.res, 200, { ok: true });
});

// ---------- MOVIMIENTOS DE STOCK (solo dueña) ----------
route('GET', '/api/movements', { owner: true }, (ctx) => sendJson(ctx.res, 200, db.movements.slice().reverse()));

route('POST', '/api/movements', { owner: true }, (ctx) => {
  const { productId, type, qty, reason, registerAsExpense } = ctx.body || {};
  const product = findOr404(ctx, db.products, productId, 'Producto');
  if (!product) return;
  if (!['ingreso', 'egreso'].includes(type)) return sendJson(ctx.res, 400, { error: 'Tipo inválido' });
  const quantity = Number(qty);
  if (!quantity || quantity <= 0) return sendJson(ctx.res, 400, { error: 'Cantidad inválida' });
  if (type === 'egreso' && product.stock < quantity) {
    return sendJson(ctx.res, 400, { error: 'No hay suficiente stock para ese egreso' });
  }
  product.stock += type === 'ingreso' ? quantity : -quantity;

  const movement = {
    id: store.nextId(db.movements),
    date: new Date().toISOString(),
    productId: product.id,
    productName: product.name,
    type,
    qty: quantity,
    reason: reason || '',
    userId: ctx.user.id
  };
  db.movements.push(movement);

  if (type === 'ingreso' && registerAsExpense) {
    db.expenses.push({
      id: store.nextId(db.expenses),
      date: new Date().toISOString(),
      category: 'Compra de mercadería',
      description: `${product.name} x${quantity}`,
      amount: round2(product.costPrice * quantity),
      userId: ctx.user.id
    });
  }

  persist();
  sendJson(ctx.res, 201, movement);
});

// ---------- GASTOS GENERALES (solo dueña) ----------
route('GET', '/api/expenses', { owner: true }, (ctx) => sendJson(ctx.res, 200, db.expenses.slice().reverse()));

route('POST', '/api/expenses', { owner: true }, (ctx) => {
  const { category, description, amount, date } = ctx.body || {};
  if (!amount || Number(amount) <= 0) return sendJson(ctx.res, 400, { error: 'Monto inválido' });
  const expense = {
    id: store.nextId(db.expenses),
    date: date ? new Date(date).toISOString() : new Date().toISOString(),
    category: category || 'Otro',
    description: description || '',
    amount: Number(amount),
    userId: ctx.user.id
  };
  db.expenses.push(expense);
  persist();
  sendJson(ctx.res, 201, expense);
});

route('DELETE', '/api/expenses/:id', { owner: true }, (ctx) => {
  const idx = db.expenses.findIndex((e) => e.id === Number(ctx.params.id));
  if (idx === -1) return sendJson(ctx.res, 404, { error: 'Gasto no encontrado' });
  db.expenses.splice(idx, 1);
  persist();
  sendJson(ctx.res, 200, { ok: true });
});

// ---------- CLIENTES (cuenta corriente) ----------
route('GET', '/api/clients', { auth: true }, (ctx) => {
  sendJson(ctx.res, 200, db.clients.map((c) => ({ ...c, balance: clientBalance(c.id) })));
});

route('POST', '/api/clients', { auth: true }, (ctx) => {
  const { name, phone, notes } = ctx.body || {};
  if (!name) return sendJson(ctx.res, 400, { error: 'Falta el nombre de la clienta' });
  const client = { id: store.nextId(db.clients), name, phone: phone || '', notes: notes || '' };
  db.clients.push(client);
  persist();
  sendJson(ctx.res, 201, client);
});

route('PUT', '/api/clients/:id', { owner: true }, (ctx) => {
  const client = findOr404(ctx, db.clients, ctx.params.id, 'Clienta');
  if (!client) return;
  Object.assign(client, ctx.body || {});
  persist();
  sendJson(ctx.res, 200, client);
});

route('DELETE', '/api/clients/:id', { owner: true }, (ctx) => {
  const idx = db.clients.findIndex((c) => c.id === Number(ctx.params.id));
  if (idx === -1) return sendJson(ctx.res, 404, { error: 'Clienta no encontrada' });
  db.clients.splice(idx, 1);
  persist();
  sendJson(ctx.res, 200, { ok: true });
});

route('GET', '/api/clients/:id/ledger', { auth: true }, (ctx) => {
  const client = findOr404(ctx, db.clients, ctx.params.id, 'Clienta');
  if (!client) return;
  const charges = db.ccCharges.filter((c) => c.clientId === client.id).map((c) => ({ ...c, kind: 'cargo' }));
  const payments = db.ccPayments.filter((p) => p.clientId === client.id).map((p) => ({ ...p, kind: 'pago' }));
  const movements = [...charges, ...payments].sort((a, b) => new Date(a.date) - new Date(b.date));
  sendJson(ctx.res, 200, { client, balance: clientBalance(client.id), movements });
});

route('POST', '/api/clients/:id/payments', { auth: true }, (ctx) => {
  const client = findOr404(ctx, db.clients, ctx.params.id, 'Clienta');
  if (!client) return;
  const { amount, paymentMethod, note } = ctx.body || {};
  if (!amount || Number(amount) <= 0) return sendJson(ctx.res, 400, { error: 'Monto inválido' });
  const payment = {
    id: store.nextId(db.ccPayments),
    clientId: client.id,
    date: new Date().toISOString(),
    amount: Number(amount),
    paymentMethod: paymentMethod || 'efectivo',
    note: note || '',
    userId: ctx.user.id
  };
  db.ccPayments.push(payment);
  persist();
  sendJson(ctx.res, 201, payment);
});

route('DELETE', '/api/payments/:id', { owner: true }, (ctx) => {
  const idx = db.ccPayments.findIndex((p) => p.id === Number(ctx.params.id));
  if (idx === -1) return sendJson(ctx.res, 404, { error: 'Pago no encontrado' });
  db.ccPayments.splice(idx, 1);
  persist();
  sendJson(ctx.res, 200, { ok: true });
});

route('POST', '/api/clients/:id/charges', { owner: true }, (ctx) => {
  const client = findOr404(ctx, db.clients, ctx.params.id, 'Clienta');
  if (!client) return;
  const { amount, description } = ctx.body || {};
  if (!amount || Number(amount) <= 0) return sendJson(ctx.res, 400, { error: 'Monto inválido' });
  const charge = {
    id: store.nextId(db.ccCharges),
    clientId: client.id,
    date: new Date().toISOString(),
    productId: null,
    productName: description || 'Ajuste manual',
    amount: Number(amount)
  };
  db.ccCharges.push(charge);
  persist();
  sendJson(ctx.res, 201, charge);
});

// ---------- VENTAS DIARIAS ----------
route('GET', '/api/sales', { auth: true }, (ctx) => {
  const date = ctx.query.get('date');
  const from = ctx.query.get('from');
  const to = ctx.query.get('to');
  let sales = db.sales.slice();
  if (date) {
    sales = sales.filter((s) => s.date.slice(0, 10) === date);
  } else if (from || to) {
    sales = sales.filter((s) => {
      const d = s.date.slice(0, 10);
      return (!from || d >= from) && (!to || d <= to);
    });
  }
  sendJson(ctx.res, 200, sales.slice().reverse());
});

route('POST', '/api/sales', { auth: true }, (ctx) => {
  const { productId, qty, unitPrice, discountType, discountValue, paymentMethod, isCuentaCorriente, clientId, note } = ctx.body || {};
  const product = findOr404(ctx, db.products, productId, 'Producto');
  if (!product) return;
  const quantity = Number(qty) || 1;
  if (product.stock < quantity) {
    return sendJson(ctx.res, 400, { error: `Stock insuficiente. Quedan ${product.stock} unidades de ${product.name}.` });
  }
  const price = unitPrice != null && unitPrice !== '' ? Number(unitPrice) : product.salePrice;
  let discountAmt = 0;
  if (discountType === 'percent') {
    discountAmt = round2((price * quantity * (Number(discountValue) || 0)) / 100);
  } else if (discountType === 'amount') {
    discountAmt = round2(Number(discountValue) || 0);
  }
  const subtotal = round2(price * quantity);
  const total = round2(Math.max(0, subtotal - discountAmt));

  let client = null;
  if (isCuentaCorriente) {
    if (!clientId) return sendJson(ctx.res, 400, { error: 'Elegí una clienta para la cuenta corriente' });
    client = findOr404(ctx, db.clients, clientId, 'Clienta');
    if (!client) return;
  }

  product.stock -= quantity;

  const sale = {
    id: store.nextId(db.sales),
    date: normalizeDateInput(ctx.body.date),
    employeeId: ctx.user.id,
    employeeName: ctx.user.name,
    productId: product.id,
    productName: product.name,
    qty: quantity,
    unitPrice: price,
    discountAmt,
    total,
    paymentMethod: isCuentaCorriente ? 'cuenta_corriente' : paymentMethod || 'efectivo',
    clientId: client ? client.id : null,
    clientName: client ? client.name : null,
    note: note || ''
  };
  db.sales.push(sale);

  if (isCuentaCorriente) {
    db.ccCharges.push({
      id: store.nextId(db.ccCharges),
      clientId: client.id,
      date: sale.date,
      productId: product.id,
      productName: product.name,
      amount: total,
      saleId: sale.id
    });
  }

  persist();
  sendJson(ctx.res, 201, sale);
});

// Venta con varias prendas al mismo tiempo (misma clienta, un solo descuento
// y un solo medio de pago para toda la compra). Crea una fila de venta por
// cada prenda, todas con el mismo `groupId`, para que el historial y las
// cuentas corrientes las puedan mostrar agrupadas o tratarlas individualmente
// (por ejemplo, para editar o borrar una sola prenda de la venta).
route('POST', '/api/sales/batch', { auth: true }, (ctx) => {
  const { items, discountType, discountValue, paymentMethod, isCuentaCorriente, clientId, note, date } = ctx.body || {};
  if (!Array.isArray(items) || items.length === 0) {
    return sendJson(ctx.res, 400, { error: 'Agregá al menos una prenda a la venta' });
  }

  const resolved = [];
  for (const it of items) {
    const product = db.products.find((p) => p.id === Number(it.productId));
    if (!product) return sendJson(ctx.res, 400, { error: 'Una de las prendas elegidas ya no existe' });
    const quantity = Number(it.qty) || 1;
    if (quantity <= 0) return sendJson(ctx.res, 400, { error: `Cantidad inválida para ${product.name}` });
    if (product.stock < quantity) {
      return sendJson(ctx.res, 400, { error: `Stock insuficiente. Quedan ${product.stock} unidades de ${product.name}.` });
    }
    const price = it.unitPrice != null && it.unitPrice !== '' ? Number(it.unitPrice) : product.salePrice;
    resolved.push({ product, quantity, price, subtotal: round2(price * quantity) });
  }

  let client = null;
  if (isCuentaCorriente) {
    if (!clientId) return sendJson(ctx.res, 400, { error: 'Elegí una clienta para la cuenta corriente' });
    client = findOr404(ctx, db.clients, clientId, 'Clienta');
    if (!client) return;
  }

  const grandSubtotal = round2(resolved.reduce((s, r) => s + r.subtotal, 0));
  let totalDiscount = 0;
  if (discountType === 'percent') {
    totalDiscount = round2((grandSubtotal * (Number(discountValue) || 0)) / 100);
  } else if (discountType === 'amount') {
    totalDiscount = round2(Number(discountValue) || 0);
  }

  const saleDate = normalizeDateInput(date);
  const createdSales = [];
  let groupId = null;
  let discountAssigned = 0;

  resolved.forEach((r, idx) => {
    let itemDiscount;
    if (idx === resolved.length - 1) {
      itemDiscount = round2(totalDiscount - discountAssigned); // el último absorbe el redondeo
    } else {
      const share = grandSubtotal > 0 ? r.subtotal / grandSubtotal : 0;
      itemDiscount = round2(totalDiscount * share);
      discountAssigned = round2(discountAssigned + itemDiscount);
    }
    const itemTotal = round2(Math.max(0, r.subtotal - itemDiscount));

    r.product.stock -= r.quantity;

    const saleId = store.nextId(db.sales);
    if (groupId === null) groupId = saleId;

    const sale = {
      id: saleId,
      groupId,
      date: saleDate,
      employeeId: ctx.user.id,
      employeeName: ctx.user.name,
      productId: r.product.id,
      productName: r.product.name,
      qty: r.quantity,
      unitPrice: r.price,
      discountAmt: itemDiscount,
      total: itemTotal,
      paymentMethod: isCuentaCorriente ? 'cuenta_corriente' : paymentMethod || 'efectivo',
      clientId: client ? client.id : null,
      clientName: client ? client.name : null,
      note: note || ''
    };
    db.sales.push(sale);
    createdSales.push(sale);

    if (isCuentaCorriente) {
      db.ccCharges.push({
        id: store.nextId(db.ccCharges),
        clientId: client.id,
        date: sale.date,
        productId: r.product.id,
        productName: r.product.name,
        amount: itemTotal,
        saleId: sale.id
      });
    }
  });

  persist();
  sendJson(ctx.res, 201, { sales: createdSales, groupId });
});

route('PUT', '/api/sales/:id', { owner: true }, (ctx) => {
  const sale = findOr404(ctx, db.sales, ctx.params.id, 'Venta');
  if (!sale) return;
  const product = db.products.find((p) => p.id === sale.productId);

  const newQty = ctx.body.qty != null && ctx.body.qty !== '' ? Number(ctx.body.qty) : sale.qty;
  if (product) {
    const diff = sale.qty - newQty;
    product.stock += diff;
    if (product.stock < 0) {
      product.stock -= diff;
      return sendJson(ctx.res, 400, { error: 'No hay stock suficiente para esa cantidad' });
    }
  }

  const price = ctx.body.unitPrice != null && ctx.body.unitPrice !== '' ? Number(ctx.body.unitPrice) : sale.unitPrice;
  let discountAmt = sale.discountAmt;
  if (ctx.body.discountType === 'percent') {
    discountAmt = round2((price * newQty * (Number(ctx.body.discountValue) || 0)) / 100);
  } else if (ctx.body.discountType === 'amount') {
    discountAmt = round2(Number(ctx.body.discountValue) || 0);
  } else if (ctx.body.discountType === 'none') {
    discountAmt = 0;
  }

  sale.qty = newQty;
  sale.unitPrice = price;
  sale.discountAmt = discountAmt;
  sale.total = round2(Math.max(0, price * newQty - discountAmt));
  if (ctx.body.paymentMethod) sale.paymentMethod = ctx.body.paymentMethod;
  if (ctx.body.note !== undefined) sale.note = ctx.body.note;
  if (ctx.body.date) sale.date = normalizeDateInput(ctx.body.date);

  const charge = db.ccCharges.find((c) => c.saleId === sale.id);
  if (charge) {
    charge.amount = sale.total;
    charge.date = sale.date;
  }

  persist();
  sendJson(ctx.res, 200, sale);
});

route('DELETE', '/api/sales/:id', { owner: true }, (ctx) => {
  const idx = db.sales.findIndex((s) => s.id === Number(ctx.params.id));
  if (idx === -1) return sendJson(ctx.res, 404, { error: 'Venta no encontrada' });
  const sale = db.sales[idx];
  const product = db.products.find((p) => p.id === sale.productId);
  if (product) product.stock += sale.qty;

  const chargeIdx = db.ccCharges.findIndex((c) => c.saleId === sale.id);
  if (chargeIdx !== -1) db.ccCharges.splice(chargeIdx, 1);

  db.sales.splice(idx, 1);
  persist();
  sendJson(ctx.res, 200, { ok: true });
});

// ---------- DASHBOARD / REPORTES ----------
route('GET', '/api/dashboard', { auth: true }, (ctx) => {
  const today = new Date().toISOString().slice(0, 10);
  const todaySales = db.sales.filter((s) => s.date.slice(0, 10) === today);
  const lowStock = db.products.filter((p) => p.stock <= p.lowStockThreshold);
  const base = {
    todayTotal: round2(todaySales.reduce((s, x) => s + x.total, 0)),
    todayCount: new Set(todaySales.map((s) => s.groupId || s.id)).size,
    lowStock: lowStock.map((p) => sanitizeProduct(p, ctx.user.role))
  };
  if (ctx.user.role === 'duena') {
    base.pendingCC = round2(db.clients.reduce((s, c) => s + clientBalance(c.id), 0));
  }
  sendJson(ctx.res, 200, base);
});

route('GET', '/api/reports/summary', { owner: true }, (ctx) => {
  const from = ctx.query.get('from');
  const to = ctx.query.get('to');
  const inRange = (dateStr) => {
    const d = dateStr.slice(0, 10);
    return (!from || d >= from) && (!to || d <= to);
  };

  const sales = db.sales.filter((s) => inRange(s.date));
  const totalVentas = round2(sales.reduce((s, x) => s + x.total, 0));
  const totalDescuentos = round2(sales.reduce((s, x) => s + x.discountAmt, 0));
  const totalCosto = round2(
    sales.reduce((s, x) => {
      const p = db.products.find((pr) => pr.id === x.productId);
      return s + (p ? p.costPrice * x.qty : 0);
    }, 0)
  );
  const gananciaBruta = round2(totalVentas - totalCosto);

  const expenses = db.expenses.filter((e) => inRange(e.date));
  const totalGastos = round2(expenses.reduce((s, x) => s + x.amount, 0));
  const gananciaNeta = round2(gananciaBruta - totalGastos);

  const porMedioPago = {};
  for (const s of sales) {
    porMedioPago[s.paymentMethod] = round2((porMedioPago[s.paymentMethod] || 0) + s.total);
  }

  const ventasPorProducto = {};
  for (const s of sales) {
    if (!ventasPorProducto[s.productName]) ventasPorProducto[s.productName] = { unidades: 0, total: 0 };
    ventasPorProducto[s.productName].unidades += s.qty;
    ventasPorProducto[s.productName].total = round2(ventasPorProducto[s.productName].total + s.total);
  }
  const topProductos = Object.entries(ventasPorProducto)
    .map(([name, v]) => ({ name, ...v }))
    .sort((a, b) => b.unidades - a.unidades)
    .slice(0, 10);

  const pendingCC = round2(db.clients.reduce((s, c) => s + clientBalance(c.id), 0));

  sendJson(ctx.res, 200, {
    totalVentas,
    totalDescuentos,
    totalCosto,
    gananciaBruta,
    totalGastos,
    gananciaNeta,
    porMedioPago,
    topProductos,
    pendingCC,
    cantidadVentas: new Set(sales.map((s) => s.groupId || s.id)).size
  });
});

// ================= ARCHIVOS ESTÁTICOS =================
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    return res.end();
  }
  const safePath = path.normalize(pathname === '/' ? '/index.html' : pathname);
  const filePath = path.join(PUBLIC_DIR, safePath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA: si no hay extensión, devolver index.html
      if (path.extname(pathname) === '') {
        return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err2, data2) => {
          if (err2) {
            res.writeHead(404);
            return res.end('No encontrado');
          }
          res.writeHead(200, { 'Content-Type': MIME['.html'] });
          res.end(data2);
        });
      }
      res.writeHead(404);
      return res.end('No encontrado');
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// ================= SERVIDOR =================
const server = http.createServer(async (req, res) => {
  try {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = decodeURIComponent(parsedUrl.pathname);

    if (!pathname.startsWith('/api/')) {
      return serveStatic(req, res, pathname);
    }

    const match = routes.find((r) => r.method === req.method && r.regex.test(pathname));
    if (!match) return sendJson(res, 404, { error: 'No encontrado' });

    const m = pathname.match(match.regex);
    const params = {};
    match.paramNames.forEach((name, i) => (params[name] = m[i + 1]));

    const user = currentUser(req);
    if (match.opts.owner && (!user || user.role !== 'duena')) {
      return sendJson(res, user ? 403 : 401, { error: user ? 'No tenés permiso para esta acción' : 'No autenticado' });
    }
    if (match.opts.auth && !user) {
      return sendJson(res, 401, { error: 'No autenticado' });
    }

    let body = {};
    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
      body = await readJsonBody(req);
    }

    await match.handler({ req, res, params, query: parsedUrl.searchParams, user, body });
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { error: 'Error interno del servidor' });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Sinergia app corriendo en http://localhost:${PORT}`);
});
