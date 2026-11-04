# Universal de Partes y Soportes

Sistema web para gestionar pedidos, facturas, clientes, inventario y proveedores.

- **Front-end:** HTML, CSS y JavaScript (Bootstrap 5) en `frontend-soportes/`
- **Back-end:** Python con FastAPI en `backend-soportes/`
- **Base de datos:** Supabase

El servidor de Python también entrega las páginas del front-end, así que **todo funciona con una sola dirección**.

## Estructura

```
Proyecto-Sistema-Soportes/
├── backend-soportes/
│   ├── main.py            ← servidor, reglas de negocio y rutas de la API
│   ├── requirements.txt   ← librerías de Python que necesita
│   └── .env.example       ← plantilla de variables secretas (copiar a .env)
└── frontend-soportes/
    ├── login.html         ← pantalla de acceso
    ├── index.html         ← el sistema (menú, tablas, formularios)
    ├── css/estilos.css    ← todo el diseño (colores y tipografías en :root)
    ├── css/fonts/         ← fuentes Barlow
    ├── js/sesion.js       ← manejo de la sesión (se cierra al cerrar la pestaña)
    ├── js/login.js        ← lógica del login
    ├── js/app.js          ← lógica del sistema
    └── img/               ← camion.png (logo), icono.png / favicon.ico (pestaña)
```

## Ejecutarlo en tu computador

```bash
cd backend-soportes
python -m venv venv
venv\Scripts\activate            # En Mac/Linux: source venv/bin/activate
pip install -r requirements.txt
copy .env.example .env           # En Mac/Linux: cp .env.example .env   (y rellena tus valores)
uvicorn main:app --reload
```

Abre http://127.0.0.1:8000

## Publicarlo en Internet (Render)

1. Sube esta carpeta a un repositorio de GitHub. El `.gitignore` ya excluye `venv/` y `.env`.
2. En https://render.com crea un **Web Service** y conecta el repositorio.
3. Configura:
   - **Root Directory:** `backend-soportes`
   - **Build Command:** `pip install -r requirements.txt`
   - **Start Command:** `uvicorn main:app --host 0.0.0.0 --port $PORT --proxy-headers --forwarded-allow-ips="*"`
4. En **Environment** agrega `SUPABASE_URL`, `SUPABASE_KEY` y `JWT_SECRET` (los mismos valores de tu `.env`).
5. Pulsa **Deploy**. Render te da una dirección como `https://soportes-auto.onrender.com`.

En el plan gratuito, Render duerme el servicio tras unos minutos sin visitas, y la primera carga después tarda cerca de un minuto.

## Reglas de negocio importantes

- **Facturar descuenta el inventario**: al crear una factura (no anulada) se resta del stock de cada producto la cantidad del pedido. Si no alcanza el stock, la factura no se crea y se avisa qué producto falta.
- **Anular o borrar una factura devuelve el stock**; reactivar una anulada lo vuelve a descontar.
- **El total y el precio los calcula el servidor**: el precio de cada línea es el del producto y el total de la factura es la suma de `cantidad × precio` de las líneas. No se aceptan valores escritos a mano.
- Un pedido solo puede tener **una factura activa**. Mientras la tenga, no se pueden agregar, cambiar ni quitar sus productos (anula la factura primero).

## Seguridad

- Sesión en `sessionStorage`: se borra al cerrar la pestaña. Cierre automático tras 15 minutos de inactividad; el token del servidor dura `JWT_HORAS` (2 por defecto) y se invalida al pulsar «Salir» o cambiar la contraseña.
- Contraseñas con bcrypt (coste 12). Política: mínimo 10 caracteres con mayúsculas, minúsculas y números.
- Límite de 5 intentos fallidos cada 5 minutos (por IP y por IP+usuario) y respuesta de tiempo constante para no revelar qué usuarios existen.
- Cabeceras de seguridad (CSP estricta, anti-clickjacking, nosniff, HSTS en HTTPS, sin caché de datos privados).
- `/docs` y `/openapi.json` desactivados; CORS cerrado por defecto; errores de base de datos no se muestran al usuario (solo en el log del servidor).
- `JWT_SECRET` debe tener al menos 32 caracteres.

## Cambio de contraseña con verificación por correo

Cambiar la contraseña **siempre** exige un código de 6 dígitos enviado al correo (funciona desde el login y desde dentro del sistema).

1. Configura el correo en `backend-soportes/.env` (ver `SMTP_*` en `.env.example`). Con Gmail necesitas una *contraseña de aplicación*.
2. Indica a qué correo llegan los códigos, de una de estas dos formas:
   - **Simple:** `CORREO_RECUPERACION=tucorreo@gmail.com` en el `.env`.
   - **Por usuario:** en Supabase > SQL Editor ejecuta:
     ```sql
     alter table usuarios add column if not exists correo text;
     update usuarios set correo = 'tucorreo@gmail.com' where usuario = 'admin';
     ```
3. Reinicia el servidor.

Seguridad del código: 6 dígitos aleatorios, vence en 10 minutos, un solo uso, máximo 5 intentos, máximo 3 solicitudes cada 15 minutos, se guarda cifrado (hash) y no se revela si el usuario existe. Al cambiar la contraseña se cierran las demás sesiones abiertas.

Para probar sin correo, pon `CODIGO_EN_CONSOLA=1` en el `.env`: el código aparece en la terminal del servidor (no usar en producción). Los códigos viven en la memoria del servidor: si lo reinicias, los pendientes se pierden y hay que pedir uno nuevo.
