# Sinergia — App de stock, ventas y cuentas corrientes

App a medida para el local de indumentaria deportiva urbana **Sinergia**.

Permite:
- Manejar el **stock**: prenda, categoría, talle, color, precio costo, precio de venta, proveedor y alerta de stock bajo.
- Registrar la **venta diaria** (prenda, precio, descuento, medio de pago) desde el celular, tablet o PC del local. Descuenta el stock automáticamente.
- Llevar **cuentas corrientes**: la clienta se lleva prendas y va pagando de a poco; queda registrado el saldo pendiente.
- Registrar **ingresos y egresos de mercadería** y **gastos generales** (alquiler, servicios, etc.).
- Ver **reportes**: ventas, descuentos, costos, ganancia neta, medios de pago y prendas más vendidas.
- Dos tipos de usuaria:
  - **Dueña**: acceso completo, incluido el precio de costo, proveedores, reportes y edición/borrado de ventas.
  - **Empleada**: puede cargar ventas, ver stock (sin precio de costo ni proveedor) y registrar pagos de cuenta corriente, pero no puede editar ni borrar ventas ni ver información de costos/ganancias.

No usa ninguna librería externa: solo necesita tener **Node.js** instalado. No hace falta correr `npm install`.

---

## 1. Usuaria inicial

La primera vez que se inicia la app se crea automáticamente una usuaria dueña:

- **Usuario:** `duena`
- **Contraseña:** `sinergia2026`

**Importante:** entrá y cambiá esta contraseña apenas la pongas en marcha (o cuando la subas a internet), y desde la sección "Usuarias" creá el usuario de tu empleada con su propia contraseña.

---

## 2. Usar la app en una compu del local (sin internet)

1. Instalá [Node.js](https://nodejs.org/) (versión 16 o superior) si no lo tenés.
2. Descomprimí esta carpeta en la compu.
3. Abrí una terminal / símbolo del sistema dentro de la carpeta `sinergia-app`.
4. Ejecutá:
   ```
   node server.js
   ```
5. Abrí el navegador en `http://localhost:3000`.

Los datos quedan guardados en el archivo `data/db.json`. Hacé una copia de ese archivo de vez en cuando (por ejemplo, subirlo a Google Drive) para tener un respaldo.

Para que la empleada la use **desde otro dispositivo dentro del mismo local** (por ejemplo, su celular conectado al mismo Wi-Fi), fijate la IP de la compu donde corre el servidor (en Windows: `ipconfig`, buscá algo como `192.168.0.X`) y en el celular entrá a `http://192.168.0.X:3000`.

---

## 3. Publicarla en internet (para usarla desde cualquier lugar)

Para que vos y tu empleada puedan entrar desde sus propios celulares, en cualquier momento y sin depender de que una compu esté prendida, lo más simple es subir la app a un servicio de hosting gratuito como **Render**:

1. Creá una cuenta en [render.com](https://render.com) (podés entrar con GitHub).
2. Subí esta carpeta a un repositorio de GitHub (podés arrastrar los archivos desde la web de GitHub si no usás git).
3. En Render, elegí **New + → Web Service**, conectá el repositorio.
4. Configuración:
   - **Build Command:** dejalo vacío (no hace falta instalar nada).
   - **Start Command:** `node server.js`
5. Creá el servicio. Render te da una URL tipo `https://sinergia-app.onrender.com` a la que se puede entrar desde cualquier celular con esa dirección.

**Aviso sobre el plan gratuito de Render:** el servidor "se duerme" tras un rato sin uso y tarda unos segundos en despertar con la primera visita del día — no es un error, es normal en el plan free. Si eso molesta, se puede pasar a un plan pago (unos pocos dólares al mes) para que esté siempre activo.

**Importante sobre los datos:** en el plan gratuito de Render el archivo `data/db.json` se puede borrar cuando el servidor se reinicia, porque el disco no es permanente. Si vas a usarla en producción de forma seria, contactame para agregarle un "disco persistente" (Render lo ofrece como opción paga) o para pasar a un plan con almacenamiento persistente. Mientras la estés probando, andá revisando que los datos no se pierdan.

---

## 4. Estructura del proyecto

```
sinergia-app/
  server.js       -> servidor y toda la lógica (API)
  db.js           -> guarda/lee los datos en data/db.json
  auth.js         -> manejo de contraseñas
  public/         -> lo que se ve en el navegador (HTML/CSS/JS)
  data/db.json    -> ahí se guarda TODA la información (se crea solo)
```

---

## 5. Cambiar la contraseña de la dueña o crear más usuarias

Como dueña, andá a **Usuarias** en el menú y desde ahí podés crear, editar o borrar usuarias (incluida tu propia contraseña, que también podés cambiar entrando con el usuario correspondiente).

---

## 6. Ideas para más adelante

Si en el futuro querés sumar cosas como fotos de las prendas, códigos de barra, notificaciones por WhatsApp de cuentas corrientes vencidas, o pasar a una base de datos más robusta para manejar mucho volumen, esta base está pensada para poder ampliarse.
