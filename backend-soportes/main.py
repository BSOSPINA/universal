import hashlib
import hmac
import logging
import math
import os
import re
import secrets
import smtplib
import ssl
import threading
import time
import uuid
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path

import bcrypt
import jwt
from email.message import EmailMessage

from dotenv import load_dotenv
from fastapi import Body, Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from supabase import Client, create_client

load_dotenv()
SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_KEY"]
JWT_SECRET = os.environ["JWT_SECRET"]
if len(JWT_SECRET) < 32:
    raise RuntimeError("JWT_SECRET es muy corto: usa una cadena aleatoria de al menos 32 caracteres "
                       "(python -c \"import secrets; print(secrets.token_urlsafe(48))\")")
JWT_HORAS = float(os.getenv("JWT_HORAS", "2"))

# Permite peticiones CORS desde cualquier origen (Vercel, localhost, etc.)
ORIGENES = [o.strip() for o in os.getenv("ORIGENES", "").split(",") if o.strip()] or ["*"]

# Envio de codigos de verificacion por correo (SMTP). Ver .env.example
SMTP_HOST = os.getenv("SMTP_HOST", "")
SMTP_PORT = int(os.getenv("SMTP_PORT", "587"))
SMTP_USER = os.getenv("SMTP_USER", "")
SMTP_PASS = os.getenv("SMTP_PASS", "")
SMTP_FROM = os.getenv("SMTP_FROM", "") or SMTP_USER
CORREO_RECUPERACION = os.getenv("CORREO_RECUPERACION", "")      # se usa si el usuario no tiene correo en la tabla
CODIGO_EN_CONSOLA = os.getenv("CODIGO_EN_CONSOLA", "0") == "1"  # SOLO para pruebas locales sin correo

NOMBRE_EMPRESA = "Universal de Partes y Soportes"

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("soportes")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

# Se desactivan /docs, /redoc y /openapi.json: no hay por que mostrar la API a desconocidos.
app = FastAPI(title=NOMBRE_EMPRESA, docs_url=None, redoc_url=None, openapi_url=None)

# Habilitar CORS universal (compatible con Vercel y local)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Politica de contenido: solo se ejecuta codigo propio y el de jsDelivr (Bootstrap).
CSP = ("default-src 'self'; "
       "script-src 'self' https://cdn.jsdelivr.net; "
       "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; "
       "font-src 'self' https://cdn.jsdelivr.net data:; "
       "img-src 'self' data:; "
       "connect-src 'self'; "
       "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'")


@app.middleware("http")
async def cabeceras_seguridad(request: Request, call_next):
    resp = await call_next(request)
    resp.headers["Content-Security-Policy"] = CSP
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["X-Frame-Options"] = "DENY"
    resp.headers["Referrer-Policy"] = "no-referrer"
    resp.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=(), payment=()"
    resp.headers["Cross-Origin-Opener-Policy"] = "same-origin"
    if request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https":
        resp.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    ruta = request.url.path
    if ruta.startswith("/api") or ruta in ("/login", "/logout") or ruta.startswith("/recuperar") or ruta.endswith(".html") or ruta == "/":
        resp.headers["Cache-Control"] = "no-store"      # nada de datos privados en el cache del navegador
    return resp


# AUTENTICACION
bearer = HTTPBearer(auto_error=False)
intentos = defaultdict(list)          # clave (ip o ip|usuario) -> instantes de intentos fallidos
MAX_INTENTOS, VENTANA = 5, 300        # 5 fallos cada 5 minutos
revocados = {}                        # jti -> expiracion (tokens cerrados con "Salir" o tras cambiar la clave)
# Hash "de mentira": se usa cuando el usuario no existe para que la respuesta tarde lo mismo
# y no se pueda adivinar que usuarios existen midiendo tiempos.
HASH_FALSO = bcrypt.hashpw(b"relleno-no-es-una-clave", bcrypt.gensalt(12)).decode()


class Credenciales(BaseModel):
    usuario: str = Field(min_length=1, max_length=60)
    clave: str = Field(min_length=1, max_length=128)


class CambioClave(BaseModel):
    clave_actual: str = Field(min_length=1, max_length=128)
    clave_nueva: str = Field(min_length=1, max_length=128)
    codigo: str = Field(min_length=6, max_length=6, pattern=r"^\d{6}$")


class SolicitudCodigo(BaseModel):
    usuario: str = Field(min_length=1, max_length=60)


class Recuperacion(BaseModel):
    usuario: str = Field(min_length=1, max_length=60)
    codigo: str = Field(min_length=6, max_length=6, pattern=r"^\d{6}$")
    clave_nueva: str = Field(min_length=1, max_length=128)


def clave_ok(clave: str, guardada) -> bool:
    guardada = guardada or ""
    if guardada.startswith("$2"):
        try:
            return bcrypt.checkpw(clave.encode()[:72], guardada.encode())
        except ValueError:
            return False
    # Contrasena aun en texto plano: se compara y luego se migra a hash
    return hmac.compare_digest(clave.encode(), guardada.encode())


def hashear(clave: str) -> str:
    return bcrypt.hashpw(clave.encode()[:72], bcrypt.gensalt(12)).decode()


def ip_de(request: Request) -> str:
    return request.client.host if request.client else "?"


def bloqueado(llave: str) -> bool:
    ahora = time.time()
    intentos[llave] = [t for t in intentos[llave] if ahora - t < VENTANA]
    if not intentos[llave]:
        intentos.pop(llave, None)
        return False
    return len(intentos[llave]) >= MAX_INTENTOS


def falla(llave: str):
    intentos[llave].append(time.time())
    if len(intentos) > 5000:      # evita que la memoria crezca sin limite
        for k in [k for k, v in intentos.items() if not v or time.time() - v[-1] > VENTANA]:
            intentos.pop(k, None)


def crear_token(usuario: str) -> str:
    ahora = datetime.now(timezone.utc)
    return jwt.encode(
        {"sub": usuario, "jti": uuid.uuid4().hex, "iat": ahora, "exp": ahora + timedelta(hours=JWT_HORAS)},
        JWT_SECRET, algorithm="HS256")


def revocar(carga: dict):
    revocados[carga["jti"]] = carga["exp"]
    ahora = time.time()
    for k in [k for k, exp in revocados.items() if exp < ahora]:
        revocados.pop(k, None)


def validar_clave_nueva(clave: str, usuario: str):
    """Politica de contrasenas. Devuelve el mensaje de error o None si es aceptable."""
    if len(clave) < 10:
        return "La contraseña nueva debe tener al menos 10 caracteres."
    if len(clave.encode()) > 72:
        return "La contraseña nueva es demasiado larga (máximo 72 caracteres)."
    if not (re.search(r"[a-z]", clave) and re.search(r"[A-Z]", clave) and re.search(r"\d", clave)):
        return "La contraseña nueva debe mezclar mayúsculas, minúsculas y números."
    if usuario.lower() in clave.lower():
        return "La contraseña nueva no puede contener tu nombre de usuario."
    if re.search(r"(.)\1{3,}", clave) or clave.lower() in ("contraseña123", "password123", "admin12345", "aadmin12345"):
        return "La contraseña nueva es demasiado predecible."
    return None


@app.post("/login")
def login(datos: Credenciales, request: Request):
    ip = ip_de(request)
    llaves = (ip, f"{ip}|{datos.usuario.lower()}")
    if any(bloqueado(k) for k in llaves):
        log.warning("login bloqueado por demasiados intentos: ip=%s usuario=%s", ip, datos.usuario)
        raise HTTPException(429, "Demasiados intentos. Espera unos minutos.")

    filas = db(lambda: supabase.table("usuarios").select("*").eq("usuario", datos.usuario).limit(1).execute().data)
    if filas:
        correcto = clave_ok(datos.clave, filas[0].get("clave"))
    else:
        bcrypt.checkpw(datos.clave.encode()[:72], HASH_FALSO.encode())   # gasta el mismo tiempo
        correcto = False
    if not correcto:
        for k in llaves:
            falla(k)
        log.warning("login fallido: ip=%s usuario=%s", ip, datos.usuario)
        raise HTTPException(401, "Usuario o contraseña incorrectos")

    if not (filas[0].get("clave") or "").startswith("$2"):
        try:  # migrar la clave en texto plano a hash
            supabase.table("usuarios").update({"clave": hashear(datos.clave)}).eq("usuario", datos.usuario).execute()
        except Exception:
            log.exception("no se pudo migrar la clave de %s a hash", datos.usuario)

    for k in llaves:
        intentos.pop(k, None)
    log.info("login correcto: ip=%s usuario=%s", ip, datos.usuario)
    return {"exito": True, "token": crear_token(datos.usuario)}


# VERIFICACION POR CORREO
CODIGO_MINUTOS, CODIGO_INTENTOS = 10, 5
codigos = {}                          # usuario -> {"hash", "exp", "intentos", "enviado"}
solicitudes = defaultdict(list)       # llave -> instantes de solicitudes de codigo
cortes = {}                           # usuario -> instante desde el cual los tokens anteriores ya no valen


def limite(llave: str, maximo: int, ventana: int) -> bool:
    """True si ya se paso del limite; si no, registra este intento."""
    ahora = time.time()
    solicitudes[llave] = [t for t in solicitudes[llave] if ahora - t < ventana]
    if len(solicitudes[llave]) >= maximo:
        return True
    solicitudes[llave].append(ahora)
    return False


def hash_codigo(usuario: str, codigo: str) -> str:
    return hmac.new(JWT_SECRET.encode(), f"{usuario.lower()}|{codigo}".encode(), hashlib.sha256).hexdigest()


def correo_de(fila: dict) -> str:
    return (fila.get("correo") or CORREO_RECUPERACION or "").strip()


def ocultar_correo(c: str) -> str:
    nombre, _, dominio = c.partition("@")
    return (nombre[:1] + "***@" + dominio) if dominio else "***"


def enviar_correo(destino: str, asunto: str, texto: str):
    if not (SMTP_HOST and SMTP_FROM):
        raise RuntimeError("SMTP no configurado")
    msg = EmailMessage()
    msg["Subject"], msg["From"], msg["To"] = asunto, f"{NOMBRE_EMPRESA} <{SMTP_FROM}>", destino
    msg.set_content(texto)
    ctx = ssl.create_default_context()
    if SMTP_PORT == 465:
        with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, context=ctx, timeout=15) as srv:
            if SMTP_USER:
                srv.login(SMTP_USER, SMTP_PASS)
            srv.send_message(msg)
    else:
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=15) as srv:
            srv.starttls(context=ctx)
            if SMTP_USER:
                srv.login(SMTP_USER, SMTP_PASS)
            srv.send_message(msg)


def crear_codigo(usuario: str) -> str:
    codigo = f"{secrets.randbelow(1_000_000):06d}"
    codigos[usuario.lower()] = {"hash": hash_codigo(usuario, codigo), "intentos": 0,
                                "exp": time.time() + CODIGO_MINUTOS * 60, "enviado": time.time()}
    return codigo


def entregar_codigo(usuario: str, destino: str, codigo: str):
    """Envia el codigo por correo. Lanza error si no se pudo entregar."""
    if SMTP_HOST:
        enviar_correo(destino, f"Tu código de verificación · {NOMBRE_EMPRESA}",
                      f"Hola {usuario},\n\nTu código para cambiar la contraseña es:\n\n    {codigo}\n\n"
                      f"Vence en {CODIGO_MINUTOS} minutos y solo sirve una vez.\n"
                      "Si no lo pediste tú, ignora este mensaje y avisa al administrador.\n")
    elif CODIGO_EN_CONSOLA:
        log.warning("MODO PRUEBA: código de %s = %s (no se envió correo)", usuario, codigo)
    else:
        raise RuntimeError("El envío de correos no está configurado")


def verificar_codigo(usuario: str, codigo: str):
    """Comprueba y CONSUME el codigo. Maximo 5 intentos por codigo."""
    reg = codigos.get(usuario.lower())
    if not reg or reg["exp"] < time.time():
        codigos.pop(usuario.lower(), None)
        raise HTTPException(400, "El código no es válido o ya venció. Pide uno nuevo.")
    if not hmac.compare_digest(reg["hash"], hash_codigo(usuario, codigo)):
        reg["intentos"] += 1
        if reg["intentos"] >= CODIGO_INTENTOS:
            codigos.pop(usuario.lower(), None)
            raise HTTPException(400, "Demasiados códigos incorrectos. Pide uno nuevo.")
        raise HTTPException(400, f"Código incorrecto. Te quedan {CODIGO_INTENTOS - reg['intentos']} intentos.")
    codigos.pop(usuario.lower(), None)        # un solo uso


def cerrar_sesiones(usuario: str):
    cortes[usuario.lower()] = int(time.time())


MSG_SOLICITUD = "Si el usuario existe y tiene un correo registrado, enviamos un código de 6 dígitos. Revisa tu bandeja (y el spam)."


@app.post("/recuperar/solicitar")
def recuperar_solicitar(datos: SolicitudCodigo, request: Request):
    """Paso 1 (desde el login): manda un codigo al correo del usuario. La respuesta es igual exista o no."""
    ip, usuario = ip_de(request), datos.usuario.strip()
    if limite(f"cod-ip|{ip}", 10, 900) or limite(f"cod|{usuario.lower()}", 3, 900):
        raise HTTPException(429, "Demasiadas solicitudes. Espera unos minutos.")
    fila = db(lambda: supabase.table("usuarios").select("*").eq("usuario", usuario).limit(1).execute().data)
    destino = correo_de(fila[0]) if fila else ""
    if fila and destino:
        codigo = crear_codigo(usuario)

        def tarea():                      # en segundo plano: la respuesta tarda lo mismo exista o no
            try:
                entregar_codigo(usuario, destino, codigo)
                log.info("código enviado: usuario=%s ip=%s", usuario, ip)
            except Exception:
                log.exception("no se pudo enviar el código a %s", usuario)
        threading.Thread(target=tarea, daemon=True).start()
    else:
        log.warning("código pedido para usuario inexistente o sin correo: %s ip=%s", usuario, ip)
    return {"ok": True, "mensaje": MSG_SOLICITUD}


@app.post("/recuperar/confirmar")
def recuperar_confirmar(datos: Recuperacion, request: Request):
    """Paso 2 (desde el login): codigo + contraseña nueva."""
    ip, usuario = ip_de(request), datos.usuario.strip()
    llaves = (ip, f"{ip}|{usuario.lower()}")
    if any(bloqueado(k) for k in llaves):
        raise HTTPException(429, "Demasiados intentos. Espera unos minutos.")
    error = validar_clave_nueva(datos.clave_nueva, usuario)
    if error:                               # se revisa antes para no gastar el código por una clave floja
        raise HTTPException(400, error)
    try:
        verificar_codigo(usuario, datos.codigo)
    except HTTPException:
        for k in llaves:
            falla(k)
        log.warning("código rechazado en recuperación: usuario=%s ip=%s", usuario, ip)
        raise
    db(lambda: supabase.table("usuarios").update({"clave": hashear(datos.clave_nueva)}).eq("usuario", usuario).execute())
    cerrar_sesiones(usuario)
    for k in llaves:
        intentos.pop(k, None)
    log.info("clave cambiada por verificación de correo: usuario=%s ip=%s", usuario, ip)
    return {"ok": True}


def carga_token(cred: HTTPAuthorizationCredentials = Depends(bearer)) -> dict:
    if not cred:
        raise HTTPException(401, "No autenticado")
    try:
        carga = jwt.decode(cred.credentials, JWT_SECRET, algorithms=["HS256"],
                           options={"require": ["exp", "sub", "jti"]})
    except jwt.PyJWTError as ex:
        log.info("token rechazado: %r", ex)
        raise HTTPException(401, "Sesión inválida o expirada")
    if carga["jti"] in revocados:
        raise HTTPException(401, "Sesión cerrada")
    if int(carga.get("iat", 0)) < cortes.get(carga["sub"].lower(), 0):
        raise HTTPException(401, "Sesión cerrada: la contraseña fue cambiada")
    return carga


def usuario_actual(carga: dict = Depends(carga_token)) -> str:
    return carga["sub"]


@app.post("/logout")
def logout(carga: dict = Depends(carga_token)):
    revocar(carga)
    return {"ok": True}


@app.post("/api/cuenta/clave/codigo")
def pedir_codigo_cuenta(request: Request, carga: dict = Depends(carga_token)):
    """Desde dentro del sistema: manda el codigo de verificacion al correo del usuario."""
    usuario, ip = carga["sub"], ip_de(request)
    if limite(f"cod-ip|{ip}", 10, 900) or limite(f"cod|{usuario.lower()}", 3, 900):
        raise HTTPException(429, "Demasiadas solicitudes. Espera unos minutos.")
    fila = db(lambda: supabase.table("usuarios").select("*").eq("usuario", usuario).limit(1).execute().data)
    destino = correo_de(fila[0]) if fila else ""
    if not destino:
        raise HTTPException(400, "Tu usuario no tiene un correo registrado. Pídele al administrador que lo agregue.")
    codigo = crear_codigo(usuario)
    try:
        entregar_codigo(usuario, destino, codigo)
    except Exception:
        codigos.pop(usuario.lower(), None)
        log.exception("no se pudo enviar el código a %s", usuario)
        raise HTTPException(503, "No se pudo enviar el correo. Revisa la configuración SMTP del servidor.")
    log.info("código enviado (sesión): usuario=%s ip=%s", usuario, ip)
    return {"ok": True, "destino": ocultar_correo(destino) if SMTP_HOST else "la consola del servidor (modo prueba)"}


@app.post("/api/cuenta/clave")
def cambiar_clave(datos: CambioClave, request: Request, carga: dict = Depends(carga_token)):
    usuario = carga["sub"]
    llave = f"{ip_de(request)}|clave|{usuario.lower()}"
    if bloqueado(llave):
        raise HTTPException(429, "Demasiados intentos. Espera unos minutos.")
    filas = db(lambda: supabase.table("usuarios").select("*").eq("usuario", usuario).limit(1).execute().data)
    if not filas or not clave_ok(datos.clave_actual, filas[0].get("clave")):
        falla(llave)
        log.warning("cambio de clave rechazado (clave actual incorrecta): usuario=%s", usuario)
        raise HTTPException(400, "La contraseña actual no es correcta.")
    if hmac.compare_digest(datos.clave_actual.encode(), datos.clave_nueva.encode()):
        raise HTTPException(400, "La contraseña nueva debe ser distinta de la actual.")
    error = validar_clave_nueva(datos.clave_nueva, usuario)
    if error:
        raise HTTPException(400, error)
    try:
        verificar_codigo(usuario, datos.codigo)
    except HTTPException:
        falla(llave)
        raise
    db(lambda: supabase.table("usuarios").update({"clave": hashear(datos.clave_nueva)}).eq("usuario", usuario).execute())
    intentos.pop(llave, None)
    revocar(carga)
    cerrar_sesiones(usuario)                  # cualquier otra sesion abierta tambien se cierra
    log.info("clave cambiada: usuario=%s ip=%s", usuario, ip_de(request))
    return {"ok": True, "token": crear_token(usuario)}


# REGLAS DE VALIDACION

L = "A-Za-zÁÉÍÓÚÜÑáéíóúüñ"     # letras con tildes y ñ

FORMATOS = {
    "email": {
        "re": r"^[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,}$",
        "msg": "debe ser un correo válido, por ejemplo nombre@empresa.com", "min": 6, "max": 100},
    "tel": {
        "re": r"^\+?\d{7,13}$",
        "msg": "debe ser un teléfono válido: solo números, entre 7 y 13 dígitos", "min": 7, "max": 20},
    "persona": {
        "re": rf"^[{L}]+(?:[ .'\-][{L}]+)*\.?$",
        "msg": "solo puede tener letras y espacios", "min": 3, "max": 100},
    "empresa": {
        "re": rf"^(?=(?:.*[{L}]){{2}})[{L}0-9 .,&'()\-]+$",
        "msg": "solo puede tener letras, números y los símbolos . , & ( ) -", "min": 3, "max": 100},
    "texto": {
        "re": rf"^(?=(?:.*[{L}]){{2}})[{L}0-9 .,/&'\"()+\-#°%]+$",
        "msg": "tiene caracteres no permitidos (use letras, números y . , / & ( ) + - # %)", "min": 2, "max": 100},
    "direccion": {
        "re": r"^.+$",
        "msg": "no tiene el formato estándar: elige el tipo de vía y completa número, cruce-placa y ciudad (ej: Calle 45 # 12-30, Bogotá)",
        "min": 5, "max": 150},
    "codigo": {
        "re": r"^[A-Z]{2,5}-\d{3,8}$",
        "msg": "debe tener el formato PED-1001", "min": 6, "max": 15},
    "parrafo": {
        "re": r"^[^<>]*$",
        "msg": "no puede contener los símbolos < ni >", "min": 0, "max": 500},
}
for _f in FORMATOS.values():
    _f["rx"] = re.compile(_f["re"])

# Formato del numero de identificacion segun el tipo
REGLAS_ID = {
    "CC": (r"\d{6,10}", "de 6 a 10 dígitos"),
    "TI": (r"\d{6,11}", "de 6 a 11 dígitos"),
    "CE": (r"\d{6,10}", "de 6 a 10 dígitos"),
    "NIT": (r"\d{9,10}(-\d)?", "de 9 a 10 dígitos (con o sin -dígito de verificación)"),
    "Pasaporte": (r"[A-Z0-9]{6,12}", "de 6 a 12 letras o números"),
}

# Deben coincidir con los CHECK de tu base de datos.
ESTADOS_PEDIDO = ["pendiente", "en_proceso", "finalizado", "cancelado"]
ESTADOS_FACTURA = ["pendiente", "pagada", "anulada"]
TIPOS_ID = list(REGLAS_ID)
TIPOS_RH = ["O+", "O-", "A+", "A-", "B+", "B-", "AB+", "AB-"]
UNIDADES = ["kg", "g", "lb", "t", "m", "cm", "mm", "l", "ml", "und", "m2", "rollo", "lámina", "caja"]

# Direcciones: un solo formato estandar
VIAS_CON_PLACA = ["Calle", "Carrera", "Avenida", "Avenida Calle", "Avenida Carrera",
                  "Diagonal", "Transversal", "Circular", "Autopista"]
VIAS_SIN_PLACA = ["Kilómetro", "Zona Industrial", "Vereda"]   
COMPLEMENTOS = ["Apto", "Oficina", "Bodega", "Local", "Piso", "Interior", "Casa", "Lote"]
CIUDADES = ["Bogotá", "Medellín", "Cali", "Barranquilla", "Cartagena", "Bucaramanga", "Cúcuta", "Pereira",
            "Manizales", "Ibagué", "Soacha", "Villavicencio", "Santa Marta", "Pasto", "Neiva", "Armenia",
            "Tunja", "Montería", "Valledupar", "Popayán", "Sincelejo", "Chía", "Cajicá", "Funza",
            "Mosquera", "Madrid", "Facatativá", "Zipaquirá", "Girardot"]
DIR_CFG = {"vias": VIAS_CON_PLACA + VIAS_SIN_PLACA, "sin_placa": VIAS_SIN_PLACA,
           "complementos": COMPLEMENTOS, "ciudades": CIUDADES}

_VIAS_RX = "|".join(re.escape(v) for v in sorted(VIAS_CON_PLACA + VIAS_SIN_PLACA, key=len, reverse=True))
_TOK = rf"[{L}0-9]+(?:-[{L}0-9]+)*"
DIR_RE = re.compile(
    rf"^({_VIAS_RX}) ({_TOK}(?: {_TOK}){{0,4}})"
    rf"(?: # (\d{{1,3}}[A-Za-z]?(?: Bis)?)-(\d{{1,3}}))?"
    rf"(?:, ({'|'.join(COMPLEMENTOS)}) ([A-Za-z0-9\-]{{1,10}}))?"
    rf", ([{L}]+(?: [{L}]+){{0,3}})$", re.I)


def titulo_dir(txt: str) -> str:
    """'45a bis sur' -> '45A Bis Sur'   'las américas' -> 'Las Américas'"""
    t = re.sub(r"(^|[\s-])([^\W\d_])", lambda m: m.group(1) + m.group(2).upper(), txt.lower())
    return re.sub(r"(\d)([a-z])\b", lambda m: m.group(1) + m.group(2).upper(), t)


def canonizar_direccion(txt: str):
    """Devuelve la direccion en formato estandar, o None si no cumple."""
    m = DIR_RE.match(txt)
    if not m:
        return None
    via = next(v for v in VIAS_CON_PLACA + VIAS_SIN_PLACA if v.lower() == m.group(1).lower())
    cruce, placa = m.group(3), m.group(4)
    if (via in VIAS_CON_PLACA) != bool(cruce):
        return None
    s = f"{via} {titulo_dir(m.group(2))}"
    if cruce:
        s += f" # {titulo_dir(cruce)}-{placa}"
    if m.group(5):
        s += f", {m.group(5).capitalize()} {m.group(6).upper()}"
    return f"{s}, {titulo_dir(m.group(7))}"


def F(nombre, etiqueta=None, tipo="text", req=False, fk=None, opciones=None,
      moneda=False, oculto=False, auto=False, defecto=None, formato=None,
      minimo=None, maximo=None, largo=None):
    campo = {
        "nombre": nombre,
        "etiqueta": etiqueta or nombre.replace("_", " ").capitalize(),
        "tipo": "fk" if fk else tipo,
        "req": req, "fk": fk, "opciones": opciones,
        "moneda": moneda, "oculto": oculto, "auto": auto, "defecto": defecto,
        "formato": formato, "min": minimo, "max": maximo,
        "largo": largo or (FORMATOS[formato]["max"] if formato else None),
    }
    if tipo == "direccion":
        campo["dir"] = DIR_CFG
    return campo

# DEFINICION DE MODULOS
ENTIDADES = {
    # VENTAS
    "pedido": {
        "titulo": "Pedidos", "icono": "cart", "grupo": "Ventas",
        "pk": ["id_pedido"], "prefijo": "PED", "etiqueta": "{numero_pedido}",
        "campos": [
            F("numero_pedido", "N.º de pedido", auto=True, formato="codigo"),
            F("fecha_pedido", "Fecha", tipo="date", req=True, defecto="hoy"),
            F("id_cliente", "Cliente", fk="clientes", req=True),
            F("estado_pedido", "Estado", tipo="select", opciones=ESTADOS_PEDIDO, req=True, defecto="pendiente"),
        ],
    },
    "producto_pedidos": {
        "titulo": "Detalle de pedidos", "icono": "list-check", "grupo": "Ventas",
        "pk": ["id_prod", "id_pedido"], "prefijo": None, "etiqueta": "",
        "campos": [
            F("id_pedido", "Pedido", fk="pedido", req=True),
            F("id_prod", "Producto", fk="producto", req=True),
            F("cantidad", "Cantidad", tipo="int", req=True, minimo=1, maximo=100_000),
            F("precio_unitario", "Precio unitario", tipo="int", moneda=True, auto=True,
              minimo=1, maximo=100_000_000),
        ],
    },
    "factura_venta": {
        "titulo": "Facturas de venta", "icono": "receipt", "grupo": "Ventas",
        "pk": ["id_factura"], "prefijo": "FAC", "etiqueta": "{id_factura}",
        "campos": [
            F("fecha_factura", "Fecha", tipo="date", req=True, defecto="hoy"),
            F("id_pedido", "Pedido", fk="pedido", req=True),
            F("id_empleado", "Empleado", fk="empleados"),
            F("id_metodo", "Método de pago", fk="metodo_pago"),
            F("estado_factura", "Estado", tipo="select", opciones=ESTADOS_FACTURA, req=True, defecto="pendiente"),
            F("total_factura", "Total", tipo="float", moneda=True, auto=True, maximo=10_000_000_000),
        ],
    },
    "clientes": {
        "titulo": "Clientes", "icono": "people", "grupo": "Ventas",
        "pk": ["id_cliente"], "prefijo": "CLI", "etiqueta": "{_nombre} ({id_cliente})",
        "campos": [
            F("id_persona", "Persona", fk="personas", req=True),
            F("id_empleado_asignado", "Empleado asignado", fk="empleados"),
        ],
    },
    #  INVENTARIO
    "producto": {
        "titulo": "Productos", "icono": "box-seam", "grupo": "Inventario",
        "pk": ["id_prod"], "prefijo": "PRO", "etiqueta": "{nombre_pro}",
        "campos": [
            F("nombre_pro", "Producto", req=True, formato="texto"),
            F("descripcion_producto", "Descripción", tipo="textarea", oculto=True, formato="parrafo"),
            F("precio_unitario", "Precio", tipo="int", req=True, moneda=True, minimo=1, maximo=100_000_000),
            F("stock_actual", "Stock", tipo="int", req=True, defecto=0, maximo=1_000_000),
            F("cantidad_min", "Mínimo", tipo="int", req=True, maximo=1_000_000),
            F("cantidad_max", "Máximo", tipo="int", req=True, minimo=1, maximo=1_000_000),
        ],
    },
    "materia_prima": {
        "titulo": "Materia prima", "icono": "bricks", "grupo": "Inventario",
        "pk": ["id_materia"], "prefijo": "MAT", "etiqueta": "{nombre_materia}",
        "campos": [
            F("nombre_materia", "Material", req=True, formato="texto"),
            F("stock_actual", "Stock", tipo="float", req=True, defecto=0, maximo=10_000_000),
            F("unidad_medida", "Unidad", tipo="select", opciones=UNIDADES, req=True),
        ],
    },
    # COMPRAS
    "proveedor": {
        "titulo": "Proveedores", "icono": "truck", "grupo": "Compras",
        "pk": ["id_prov"], "prefijo": "PROV", "etiqueta": "{nombre}",
        "campos": [
            F("nombre", req=True, formato="empresa"),
            F("direccion", "Dirección", tipo="direccion", formato="direccion"),
            F("telefono", "Teléfono", tipo="tel", formato="tel"),
            F("correo", "Correo", tipo="email", formato="email"),
        ],
    },
    "proveedor_materia": {
        "titulo": "Materia por proveedor", "icono": "diagram-3", "grupo": "Compras",
        "pk": ["id_prov", "id_materia"], "prefijo": None, "etiqueta": "",
        "campos": [
            F("id_prov", "Proveedor", fk="proveedor", req=True),
            F("id_materia", "Materia prima", fk="materia_prima", req=True),
            F("precio_compra", "Precio de compra", tipo="float", moneda=True, req=True,
              minimo=1, maximo=1_000_000_000),
        ],
    },
    # PERSONAL
    "personas": {
        "titulo": "Personas", "icono": "person-vcard", "grupo": "Personal",
        "pk": ["id_persona"], "prefijo": "PER", "etiqueta": "{nombre} ({numero_identificacion})",
        "campos": [
            F("nombre", req=True, formato="persona"),
            F("tipo_identificacion", "Tipo de ID", tipo="select", opciones=TIPOS_ID, req=True),
            F("numero_identificacion", "N.º de identificación", req=True, largo=15),
            F("direccion", "Dirección", tipo="direccion", formato="direccion"),
            F("telefono", "Teléfono", tipo="tel", formato="tel"),
            F("correo", "Correo", tipo="email", formato="email"),
        ],
    },
    "empleados": {
        "titulo": "Empleados", "icono": "person-badge", "grupo": "Personal",
        "pk": ["id_empleado"], "prefijo": "EMP", "etiqueta": "{_nombre} - {tipo_cargo}",
        "campos": [
            F("id_persona", "Persona", fk="personas", req=True),
            F("tipo_cargo", "Cargo", req=True, formato="persona"),
            F("rh", "RH", tipo="select", opciones=TIPOS_RH),
        ],
    },
    # CONFIGURACION
    "metodo_pago": {
        "titulo": "Métodos de pago", "icono": "credit-card", "grupo": "Configuración",
        "pk": ["id_metodo"], "prefijo": "MET", "etiqueta": "{tipo_metodo}",
        "campos": [F("tipo_metodo", "Método", req=True, formato="persona")],
    },
}

# UTILIDADES
def db(fn):
    """Ejecuta una consulta a Supabase y convierte los errores en respuestas HTTP claras."""
    try:
        return fn()
    except HTTPException:
        raise
    except Exception as ex:
        msg = str(getattr(ex, "message", "") or ex)
        if "foreign key" in msg or "23503" in msg:
            raise HTTPException(400, "No se puede completar: el registro está relacionado con otros datos o la referencia no existe.")
        if "duplicate key" in msg or "23505" in msg:
            raise HTTPException(400, "Ya existe un registro con ese ID o con esos datos (por ejemplo, la misma persona o identificación).")
        # El detalle tecnico (tablas, columnas) solo se guarda en el log del servidor, no se le muestra al usuario.
        log.error("error de base de datos: %s", msg)
        raise HTTPException(400, "No se pudo completar la operación. Revisa los datos e inténtalo de nuevo.")


def entidad(nombre: str) -> dict:
    if nombre not in ENTIDADES:
        raise HTTPException(404, "Módulo no existe")
    return ENTIDADES[nombre]


def condicion(e: dict, clave: str) -> dict:
    partes = clave.split("~")
    if len(partes) != len(e["pk"]):
        raise HTTPException(400, "Clave inválida")
    return dict(zip(e["pk"], partes))


def filtrar(q, cond: dict):
    for k, v in cond.items():
        q = q.eq(k, v)
    return q


def nuevo_id(tabla, col, prefijo):
    """Siguiente ID copiando el formato que ya usa la tabla (PROV002 -> PROV003)."""
    ids = [str(f[col]) for f in db(lambda: supabase.table(tabla).select(col).execute().data)]
    partes = [m.groups() for m in (re.match(r"^(\D+)(\d+)$", i) for i in ids) if m]
    if not partes:
        return f"{prefijo}001"
    pref = Counter(p for p, _ in partes).most_common(1)[0][0]
    propios = [n for p, n in partes if p == pref]
    return f"{pref}{str(max(int(n) for n in propios) + 1).zfill(max(len(n) for n in propios))}"


def siguiente(tabla, col, prefijo, ancho=3, inicio=1):
    """Siguiente codigo libre con prefijo fijo: PED-1001 -> PED-1002."""
    filas = db(lambda: supabase.table(tabla).select(col).like(col, f"{prefijo}%").execute().data)
    nums = []
    for f in filas:
        resto = str(f[col])[len(prefijo):]
        if resto.isdigit():
            nums.append(int(resto))
    n = max(nums) + 1 if nums else inicio
    return f"{prefijo}{str(n).zfill(ancho)}"


def reglas_extra(ent: str, out: dict, errores: list):
    """Reglas que dependen de mas de un campo."""
    if ent == "producto" and out["cantidad_min"] > out["cantidad_max"]:
        errores.append("• El mínimo no puede ser mayor que el máximo")
    if ent == "personas":
        tipo = out["tipo_identificacion"]
        num = re.sub(r"[.\s]", "", out["numero_identificacion"]).upper()
        patron, ayuda = REGLAS_ID[tipo]
        if not re.fullmatch(patron, num):
            errores.append(f"• «N.º de identificación» no es válido para {tipo}: debe ser {ayuda}")
        out["numero_identificacion"] = num


def limpiar(ent: str, e: dict, datos: dict, previo: dict = None) -> dict:
    """Valida y normaliza lo recibido. Reune todos los errores en un solo mensaje."""
    out, errores = {}, []
    hoy = date.today()
    for c in e["campos"]:
        n, et, t = c["nombre"], c["etiqueta"], c["tipo"]
        v = datos.get(n)
        if isinstance(v, str):
            v = " ".join(v.split())          # quita espacios sobrantes
        if v in (None, ""):
            if c["req"]:
                errores.append(f"• «{et}» es obligatorio")
            out[n] = None
            continue

        if t in ("int", "float"):
            try:
                x = float(v)
                if not math.isfinite(x):
                    raise ValueError
                if t == "int":
                    if x != int(x):
                        raise ValueError
                    x = int(x)
            except (TypeError, ValueError):
                errores.append(f"• «{et}» debe ser un número" + (" entero" if t == "int" else ""))
                continue
            lo = c["min"] if c["min"] is not None else 0
            if x < lo:
                errores.append(f"• «{et}» debe ser mayor o igual a {lo}")
                continue
            if c["max"] is not None and x > c["max"]:
                errores.append(f"• «{et}» no puede superar {c['max']:,}")
                continue
            v = x
        elif t == "date":
            try:
                d = date.fromisoformat(str(v))
            except ValueError:
                errores.append(f"• «{et}» no es una fecha válida")
                continue
            if not (date(2000, 1, 1) <= d <= hoy + timedelta(days=366)):
                errores.append(f"• «{et}» está fuera de un rango razonable")
                continue
            v = d.isoformat()
        elif t == "select":
            if v not in c["opciones"]:
                errores.append(f"• «{et}» tiene un valor no permitido")
                continue
        elif c["formato"] == "direccion":
            f = FORMATOS["direccion"]
            if previo and v == previo.get(n):      # dirección antigua sin cambios: no bloquea la edición
                out[n] = v
                continue
            canon = canonizar_direccion(str(v))
            if not canon or len(canon) > f["max"]:
                errores.append(f"• «{et}» {f['msg']}")
                continue
            v = canon
        elif c["formato"]:
            f = FORMATOS[c["formato"]]
            v = str(v)
            if c["formato"] == "tel":
                v = re.sub(r"[\s().\-]", "", v)
            elif c["formato"] == "email":
                v = v.lower()
            if not (f["min"] <= len(v) <= f["max"]) or not f["rx"].match(v):
                errores.append(f"• «{et}» {f['msg']}")
                continue
        out[n] = v

    if not errores:
        reglas_extra(ent, out, errores)
    if errores:
        raise HTTPException(422, "\n".join(errores))
    return out


def dinero(x) -> float:
    """Redondea a centavos con Decimal para que las sumas nunca arrastren errores de coma flotante."""
    return float(Decimal(str(x or 0)).quantize(Decimal("0.01")))


def lineas_de(id_pedido: str) -> list:
    return db(lambda: supabase.table("producto_pedidos").select("id_prod,cantidad,precio_unitario")
              .eq("id_pedido", id_pedido).execute().data)


def total_pedido(id_pedido: str) -> float:
    """Total = suma de cantidad x precio de cada linea (calculado con Decimal)."""
    t = sum(Decimal(str(l["cantidad"] or 0)) * Decimal(str(l["precio_unitario"] or 0)) for l in lineas_de(id_pedido))
    return dinero(t)


def factura_activa(id_pedido: str, excepto: str = None):
    fs = db(lambda: supabase.table("factura_venta").select("id_factura,estado_factura")
            .eq("id_pedido", id_pedido).execute().data)
    return [f for f in fs if f["estado_factura"] != "anulada" and f["id_factura"] != excepto]


def mover_stock(id_pedido: str, signo: int, verificar: bool = True):
    """Descuenta (signo=-1) o devuelve (signo=+1) al inventario las unidades de un pedido.
    Antes de descontar comprueba que alcance el stock de TODOS los productos."""
    lineas = lineas_de(id_pedido)
    pedidos = defaultdict(int)
    for l in lineas:
        pedidos[l["id_prod"]] += int(l["cantidad"] or 0)
    prods = {}
    for idp in pedidos:
        r = db(lambda: supabase.table("producto").select("id_prod,nombre_pro,stock_actual")
               .eq("id_prod", idp).limit(1).execute().data)
        if r:
            prods[idp] = r[0]
    if signo < 0 and verificar:
        faltan = [f"• {prods[i]['nombre_pro']}: hay {prods[i]['stock_actual']} y el pedido pide {c}"
                  for i, c in pedidos.items() if i in prods and (prods[i]["stock_actual"] or 0) < c]
        if faltan:
            raise HTTPException(422, "No hay stock suficiente para facturar este pedido:\n" + "\n".join(faltan))
    hechos = []
    try:
        for i, c in pedidos.items():
            if i not in prods:
                continue
            viejo = int(prods[i]["stock_actual"] or 0)
            nuevo = max(viejo + signo * c, 0)
            # "eq stock_actual viejo": si alguien lo cambio entre tanto, no se pisa su valor
            res = db(lambda: supabase.table("producto").update({"stock_actual": nuevo})
                     .eq("id_prod", i).eq("stock_actual", viejo).execute().data)
            if not res:
                raise HTTPException(409, "El inventario cambió mientras se facturaba. Inténtalo de nuevo.")
            hechos.append((i, viejo))
    except Exception:
        for i, viejo in hechos:            # deshace lo que alcanzo a hacer
            try:
                supabase.table("producto").update({"stock_actual": viejo}).eq("id_prod", i).execute()
            except Exception:
                log.exception("no se pudo revertir el stock de %s", i)
        raise


def completar(ent: str, out: dict, creando: bool, previo: dict = None):
    """Reglas de negocio: valores que SIEMPRE calcula el servidor (el navegador no los decide)."""
    if ent == "pedido" and creando and not out.get("numero_pedido"):
        out["numero_pedido"] = siguiente("pedido", "numero_pedido", "PED-", 0, 1001)

    if ent == "producto_pedidos":
        # Un pedido ya facturado no se toca: cambiaria el total y el inventario ya descontados.
        if factura_activa(out["id_pedido"]):
            raise HTTPException(422, "Este pedido ya tiene una factura activa. Anula la factura para poder modificar sus productos.")
        # El precio de la linea sale SIEMPRE del producto (no de lo que mande el navegador)
        p = db(lambda: supabase.table("producto").select("precio_unitario")
               .eq("id_prod", out["id_prod"]).limit(1).execute().data)
        if not p:
            raise HTTPException(422, "El producto seleccionado no existe.")
        out["precio_unitario"] = p[0]["precio_unitario"]

    if ent == "factura_venta":
        out["total_factura"] = total_pedido(out["id_pedido"])      # nunca se acepta un total escrito a mano
        if out["total_factura"] <= 0:
            raise HTTPException(422, "El pedido no tiene productos: agrégalos en «Detalle de pedidos» antes de facturar.")
        if out.get("estado_factura") != "anulada":
            otras = factura_activa(out["id_pedido"], excepto=(previo or {}).get("id_factura"))
            if otras:
                raise HTTPException(422, f"Este pedido ya tiene la factura {otras[0]['id_factura']}. Un pedido solo puede facturarse una vez.")


# RUTAS CRUD GENERICAS
@app.get("/api/meta")
def meta(usuario: str = Depends(usuario_actual)):
    return ENTIDADES


@app.get("/api/{ent}")
def listar(ent: str, usuario: str = Depends(usuario_actual)):
    e = entidad(ent)
    q = supabase.table(ent).select("*")
    for p in e["pk"]:
        q = q.order(p)
    filas = db(lambda: q.execute().data)
    if ent in ("clientes", "empleados"):   # adjunta el nombre de la persona
        personas = {p["id_persona"]: p["nombre"] for p in
                    db(lambda: supabase.table("personas").select("id_persona,nombre").execute().data)}
        for f in filas:
            f["_nombre"] = personas.get(f.get("id_persona"), "")
    return filas


@app.post("/api/{ent}", status_code=201)
def crear(ent: str, datos: dict = Body(...), usuario: str = Depends(usuario_actual)):
    e = entidad(ent)
    out = limpiar(ent, e, datos)
    completar(ent, out, True)
    if len(e["pk"]) == 1:                  # el ID siempre lo asigna el sistema
        out[e["pk"][0]] = nuevo_id(ent, e["pk"][0], e["prefijo"])
    if ent == "factura_venta" and out["estado_factura"] != "anulada":
        mover_stock(out["id_pedido"], -1)          # verifica y descuenta el inventario
        try:
            res = db(lambda: supabase.table(ent).insert(out).execute().data)
        except Exception:
            mover_stock(out["id_pedido"], +1, verificar=False)   # si la factura no se guardo, se devuelve el stock
            raise
        log.info("factura %s creada por %s: stock descontado", out["id_factura"], usuario)
        return res[0] if res else out
    res = db(lambda: supabase.table(ent).insert(out).execute().data)
    return res[0] if res else out


@app.put("/api/{ent}/{clave}")
def actualizar(ent: str, clave: str, datos: dict = Body(...), usuario: str = Depends(usuario_actual)):
    e = entidad(ent)
    cond = condicion(e, clave)
    previo = db(lambda: filtrar(supabase.table(ent).select("*"), cond).execute().data)
    if not previo:
        raise HTTPException(404, "Registro no encontrado")
    out = limpiar(ent, e, datos, previo[0])
    if ent == "factura_venta":
        out["id_pedido"] = previo[0]["id_pedido"]          # una factura no puede cambiar de pedido
    completar(ent, out, False, previo[0])
    for k in cond:
        out.pop(k, None)
    movimiento = 0
    if ent == "factura_venta":
        antes, despues = previo[0]["estado_factura"] != "anulada", out["estado_factura"] != "anulada"
        movimiento = -1 if (despues and not antes) else (+1 if (antes and not despues) else 0)
        if movimiento:
            mover_stock(previo[0]["id_pedido"], movimiento)   # anular devuelve stock; reactivar lo vuelve a descontar
    try:
        res = db(lambda: filtrar(supabase.table(ent).update(out), cond).execute().data)
    except Exception:
        if movimiento:
            mover_stock(previo[0]["id_pedido"], -movimiento, verificar=False)
        raise
    if not res:
        raise HTTPException(404, "Registro no encontrado")
    return res[0]


@app.delete("/api/{ent}/{clave}")
def borrar(ent: str, clave: str, usuario: str = Depends(usuario_actual)):
    e = entidad(ent)
    cond = condicion(e, clave)
    if ent == "producto_pedidos":
        if factura_activa(cond["id_pedido"]):
            raise HTTPException(422, "Este pedido ya tiene una factura activa. Anula la factura para poder modificar sus productos.")
    previo = None
    if ent == "factura_venta":
        previo = db(lambda: filtrar(supabase.table(ent).select("*"), cond).execute().data)
    res = db(lambda: filtrar(supabase.table(ent).delete(), cond).execute().data)
    if not res:
        raise HTTPException(404, "Registro no encontrado")
    if previo and previo[0]["estado_factura"] != "anulada":
        mover_stock(previo[0]["id_pedido"], +1, verificar=False)   # borrar una factura activa devuelve el stock
    log.info("registro borrado: %s %s por %s", ent, clave, usuario)
    return {"ok": True}

# FRONTEND: sirve la carpeta ../frontend-soportes en http://127.0.0.1:8000
FRONT = Path(__file__).resolve().parent.parent / "frontend-soportes"
if FRONT.is_dir():
    app.mount("/", StaticFiles(directory=FRONT, html=True), name="web")