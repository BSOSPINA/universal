    // Si la página la sirve el propio servidor (local o en Internet) las rutas son relativas.
    // Solo si abres el HTML con doble clic (file://) apunta al servidor local.
    const API = location.protocol === "file:" ? "http://127.0.0.1:8000" : "";
    let token = sessionStorage.getItem("token");
    if (!token) location.href = "login.html";

    let META = {};        // definición de módulos 
    let DB = {};          // datos de todas las tablas
    let actual = "resumen";
    let editando = null;  // fila en edición 

    const $ = (id) => document.getElementById(id);
    const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    const dinero = (n) => "$" + Number(n || 0).toLocaleString("es-CO");

    function salir(motivo) {
        // Avisa al servidor para que el token deje de servir (best effort) y limpia el navegador.
        if (token) { try { fetch(API + "/logout", { method: "POST", keepalive: true, headers: { "Authorization": "Bearer " + token } }); } catch (e) {} }
        sessionStorage.removeItem("token");
        token = null;
        location.href = "login.html" + (motivo ? "?motivo=" + motivo : "");
    }

    // Cierre automático por inactividad (15 minutos sin tocar nada)
    const INACTIVIDAD = 15 * 60 * 1000;
    let reloj;
    function reiniciarReloj() { clearTimeout(reloj); reloj = setTimeout(() => salir("inactividad"), INACTIVIDAD); }
    ["click", "keydown", "mousemove", "scroll", "touchstart"].forEach((ev) =>
        addEventListener(ev, reiniciarReloj, { passive: true }));
    reiniciarReloj();

    async function api(ruta, opc = {}) {
        const r = await fetch(API + ruta, {
            ...opc,
            headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token }
        });
        if (r.status === 401 && ruta !== "/api/cuenta/clave") { salir("expirada"); throw new Error("Sesión expirada"); }
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(typeof d.detail === "string" ? d.detail : "Datos inválidos");
        return d;
    }

    async function cargar(nombres = Object.keys(META)) {
        await Promise.all(nombres.map(async (n) => {
            try { DB[n] = await api("/api/" + n); }
            catch (e) { throw new Error(n + ": " + e.message); }
        }));
    }

    // etiquetas legibles para relaciones 
    function etiquetaFila(ent, f) {
        return META[ent].etiqueta.replace(/\{(\w+)\}/g, (_, k) => f[k] ?? "");
    }
    function etiqueta(ent, id) {
        const pk = META[ent].pk[0];
        const f = (DB[ent] || []).find((r) => r[pk] === id);
        return f ? etiquetaFila(ent, f) : id;
    }
    function valor(c, f) {
        const v = f[c.nombre];
        if (v === null || v === undefined || v === "") return "";
        if (c.fk) return etiqueta(c.fk, v);
        if (c.tipo === "select") return String(v).replace(/_/g, " ");
        return c.moneda ? dinero(v) : v;
    }

    // menú lateral
    function menu() {
        const grupos = {};
        for (const [k, e] of Object.entries(META)) (grupos[e.grupo] ||= []).push([k, e]);
        let h = `<div class="sidebar-brand"><img src="img/camion.png" alt="" class="logo-camion"><span>Universal de Partes y Soportes</span></div>
                 <a href="#" data-v="resumen"><i class="bi bi-speedometer2 me-2"></i>Resumen</a>`;
        for (const [g, items] of Object.entries(grupos)) {
            h += `<div class="grupo">${esc(g)}</div>`;
            for (const [k, e] of items)
                h += `<a href="#" data-v="${k}"><i class="bi bi-${e.icono} me-2"></i>${esc(e.titulo)}</a>`;
        }
        $("sidebar").innerHTML = h;
        $("sidebar").querySelectorAll("a").forEach((a) =>
            a.onclick = (ev) => { ev.preventDefault(); ir(a.dataset.v); });
    }

    function ir(v) {
        actual = v;
        document.querySelectorAll(".sidebar a").forEach((a) => a.classList.toggle("activo", a.dataset.v === v));
        $("titulo").textContent = v === "resumen" ? "Resumen" : META[v].titulo;
        document.body.classList.remove("menu-abierto");
        v === "resumen" ? resumen() : tabla();
    }

    // resumen
    function resumen() {
        const fac = DB.factura_venta || [], prods = DB.producto || [], ped = DB.pedido || [];
        const ventas = fac.filter((f) => (f.estado_factura || "").toLowerCase() !== "anulada")
                          .reduce((s, f) => s + Number(f.total_factura || 0), 0);
        const cerrados = ["finalizado", "cancelado", "entregado"];
        const pend = ped.filter((p) => !cerrados.includes((p.estado_pedido || "").toLowerCase()));
        const bajo = prods.filter((p) => p.cantidad_min != null && p.stock_actual <= p.cantidad_min);
        const ultimas = [...fac].sort((a, b) => String(b.fecha_factura).localeCompare(String(a.fecha_factura))).slice(0, 5);

        const card = (ico, txt, val, color) => `
            <div class="col-sm-6 col-xl-3"><div class="kpi kpi-${color}">
                <i class="bi bi-${ico}"></i>
                <div><div class="kpi-t">${txt}</div><div class="kpi-v">${val}</div></div>
            </div></div>`;

        const panel = (titulo, cab, filas, vacio) => `
            <div class="col-lg-4"><div class="card border-0 shadow-sm h-100">
                <div class="card-header bg-white fw-bold">${titulo}</div>
                <div class="table-responsive"><table class="table table-sm m-0">
                    <thead><tr>${cab.map((h) => `<th>${h}</th>`).join("")}</tr></thead>
                    <tbody>${filas.length
                        ? filas.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")
                        : `<tr><td colspan="${cab.length}" class="text-center text-secondary py-3">${vacio}</td></tr>`}
                    </tbody></table></div>
            </div></div>`;

        $("vista").innerHTML = `
            <div class="row g-3 mb-4">
                ${card("cash-coin", "Ventas facturadas", dinero(ventas), "success")}
                ${card("hourglass-split", "Pedidos pendientes", pend.length, "warning")}
                ${card("box-seam", "Productos", prods.length, "primary")}
                ${card("exclamation-triangle", "Con stock bajo", bajo.length, bajo.length ? "danger" : "secondary")}
            </div>
            <div class="row g-3">
                ${panel("Stock bajo", ["Producto", "Stock", "Mín."],
                    bajo.map((p) => [p.nombre_pro, p.stock_actual, p.cantidad_min]), "Todo el inventario está sobre el mínimo")}
                ${panel("Pedidos pendientes", ["N.º", "Cliente", "Estado"],
                    pend.slice(0, 8).map((p) => [p.numero_pedido, etiqueta("clientes", p.id_cliente), (p.estado_pedido || "").replace(/_/g, " ")]), "No hay pedidos pendientes")}
                ${panel("Últimas facturas", ["Factura", "Fecha", "Total"],
                    ultimas.map((f) => [f.id_factura, f.fecha_factura, dinero(f.total_factura)]), "Aún no hay facturas")}
            </div>`;
    }

    // tabla de cada módulo
    function tabla() {
        const e = META[actual], filas = DB[actual] || [];
        const idCol = e.pk.length === 1;
        const cols = e.campos.filter((c) => !c.oculto);

        $("vista").innerHTML = `
            <div class="d-flex flex-wrap justify-content-between align-items-center mb-3 gap-3">
                <h4 class="m-0">Gestión de ${esc(e.titulo.toLowerCase())}</h4>
                <input id="buscar" class="form-control ms-auto" style="max-width:260px" placeholder="Buscar en la tabla" aria-label="Buscar en la tabla">
                <button class="btn btn-primary" id="btn-nuevo"><i class="bi bi-plus-lg me-1"></i>Nuevo registro</button>
            </div>
            <div class="table-container"><div class="table-responsive">
                <table class="table table-hover m-0 align-middle">
                    <thead class="encabezado-tabla"><tr>
                        ${idCol ? "<th>ID</th>" : ""}${cols.map((c) => `<th>${esc(c.etiqueta)}</th>`).join("")}
                        <th style="width:140px">Acciones</th>
                    </tr></thead>
                    <tbody id="tbody"></tbody>
                </table>
            </div></div>`;

        const pintar = (q) => {
            const vis = filas.filter((r) =>
                !q || [r[e.pk[0]], ...cols.map((c) => valor(c, r))].join(" ").toLowerCase().includes(q));
            $("tbody").innerHTML = vis.length ? vis.map((r) => {
                const i = filas.indexOf(r);
                return `<tr data-i="${i}">
                    ${idCol ? `<td>${esc(r[e.pk[0]])}</td>` : ""}
                    ${cols.map((c) => `<td>${c.tipo === "select" && c.nombre.startsWith("estado") ? badge(r[c.nombre]) : esc(valor(c, r))}</td>`).join("")}
                    <td>
                        <button class="btn-icono" title="Ver detalle" aria-label="Ver detalle" data-acc="ver" data-i="${i}"><i class="bi bi-eye"></i></button>
                        ${actual === "factura_venta" ? `<button class="btn-icono" title="Ver e imprimir factura" aria-label="Ver e imprimir factura" data-acc="factura" data-i="${i}"><i class="bi bi-printer"></i></button>` : ""}
                        <button class="btn-icono" title="Editar" aria-label="Editar" data-acc="editar" data-i="${i}"><i class="bi bi-pencil"></i></button>
                        <button class="btn-icono borrar" title="Borrar" aria-label="Borrar" data-acc="borrar" data-i="${i}"><i class="bi bi-trash"></i></button>
                    </td></tr>`;
            }).join("") : `<tr><td colspan="${cols.length + 2}" class="text-center text-secondary py-4">
                    Sin registros. Usa «Nuevo registro» para agregar el primero.</td></tr>`;
        };
        pintar("");
        $("buscar").oninput = (ev) => pintar(ev.target.value.toLowerCase());
        $("btn-nuevo").onclick = () => abrir(null);
        $("tbody").onclick = (ev) => {
            const b = ev.target.closest("button[data-acc]");
            if (b) {
                const i = Number(b.dataset.i);
                if (b.dataset.acc === "ver") detalleFila(i);
                else if (b.dataset.acc === "editar") abrir(i);
                else if (b.dataset.acc === "borrar") borrar(i);
                else if (b.dataset.acc === "factura") verFactura(filas[i].id_factura);
                return;
            }
            const tr = ev.target.closest("tr[data-i]");
            if (tr) detalleFila(Number(tr.dataset.i));
        };
    }

    // formulario
    const modal = () => bootstrap.Modal.getOrCreateInstance($("modal"));
    const campo = (t, html) => `<label class="small text-secondary fw-bold mb-1">${esc(t)}</label><div class="mb-3">${html}</div>`;

    // direcciones con formato estándar
    const tituloDir = (t) => String(t || "").trim().replace(/\s+/g, " ").toLowerCase()
        .replace(/(^|[\s-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase())
        .replace(/(\d)([a-z])\b/g, (m, d, l) => d + l.toUpperCase());

    function dirCompose(p, sinPlaca) {
        const nom = tituloDir(p.nom), cruce = tituloDir(p.cruce), ciudad = tituloDir(p.ciudad);
        if (!p.via || !nom) return "";
        let s = `${p.via} ${nom}`;
        if (!sinPlaca && (cruce || p.placa.trim())) s += ` # ${cruce}-${p.placa.trim()}`;
        if (p.ctipo || p.cval.trim()) s += `, ${p.ctipo} ${p.cval.trim().toUpperCase()}`;
        if (ciudad) s += `, ${ciudad}`;
        return s;
    }

    function dirParse(txt, d) {
        if (!txt) return null;
        const vias = [...d.vias].sort((a, b) => b.length - a.length).join("|");
        const m = new RegExp(`^(${vias})\\s(.+?)(?:\\s#\\s(\\S+?)-(\\d{1,3}))?(?:,\\s(${d.complementos.join("|")})\\s([^,]+))?,\\s([^,]+)$`).exec(txt);
        return m ? { via: m[1], nom: m[2], cruce: m[3] || "", placa: m[4] || "", ctipo: m[5] || "", cval: m[6] || "", ciudad: m[7] } : null;
    }

    function entradaDireccion(c, val, dis) {
        const d = c.dir, p = dirParse(val, d);
        const legacy = val && !p ? String(val) : "";     // dirección guardada con el formato antiguo
        const v = p || { via: "", nom: "", cruce: "", placa: "", ctipo: "", cval: "", ciudad: "" };
        const ch = dis;
        const ops = (lista, sel, vacio) => `<option value="">${vacio}</option>` +
            lista.map((o) => `<option ${o === sel ? "selected" : ""}>${esc(o)}</option>`).join("");
        return `<div class="dir-widget border rounded p-2 bg-white" data-sinplaca="${esc(d.sin_placa.join("|"))}" data-legacy="${esc(legacy)}">
            ${legacy ? `<div class="alert alert-warning py-1 small">Dirección anterior (formato antiguo): <b>${esc(legacy)}</b>.
                Se conserva si no llenas los campos; llénalos para reemplazarla.</div>` : ""}
            <div class="row g-2">
                <div class="col-5"><select class="form-select form-select-sm" data-d="via" ${ch}>${ops(d.vias, v.via, "Tipo de vía")}</select></div>
                <div class="col-7"><input class="form-control form-control-sm" data-d="nom" value="${esc(v.nom)}" maxlength="40"
                    placeholder="Número o nombre (45A, Las Américas)" ${ch}></div>
                <div class="col-12 dir-placa"><div class="input-group input-group-sm"><span class="input-group-text">#</span>
                    <input class="form-control" data-d="cruce" value="${esc(v.cruce)}" maxlength="8" placeholder="Cruce (12, 12A)" ${ch}>
                    <span class="input-group-text">-</span>
                    <input class="form-control" data-d="placa" value="${esc(v.placa)}" maxlength="3" inputmode="numeric" placeholder="Placa (30)" ${dis}></div></div>
                <div class="col-5"><select class="form-select form-select-sm" data-d="ctipo" ${ch}>${ops(d.complementos, v.ctipo, "Complemento")}</select></div>
                <div class="col-7"><input class="form-control form-control-sm" data-d="cval" value="${esc(v.cval)}" maxlength="10"
                    placeholder="Número (301, 4B)" ${ch}></div>
                <div class="col-12"><input class="form-control form-control-sm" data-d="ciudad" list="ciudades-${c.nombre}" value="${esc(v.ciudad)}"
                    maxlength="40" placeholder="Ciudad (obligatoria)" ${ch}></div>
            </div>
            <datalist id="ciudades-${c.nombre}">${d.ciudades.map((x) => `<option value="${esc(x)}">`).join("")}</datalist>
            <div class="small text-secondary mt-2">Se guardará como: <b class="dir-vista">—</b></div>
            <input type="hidden" id="f-${c.nombre}" value="${esc(val)}">
        </div>`;
    }

    function dirCambio(el) {
        const w = el.closest(".dir-widget"), g = (k) => w.querySelector(`[data-d="${k}"]`);
        const p = { via: g("via").value, nom: g("nom").value, cruce: g("cruce").value, placa: g("placa").value,
                    ctipo: g("ctipo").value, cval: g("cval").value, ciudad: g("ciudad").value };
        const sinPlaca = w.dataset.sinplaca.split("|").includes(p.via);
        w.querySelector(".dir-placa").classList.toggle("d-none", sinPlaca);
        let s = dirCompose(p, sinPlaca);
        const algo = Object.values(p).some((x) => String(x).trim());
        if (!s && algo) s = "dirección incompleta";               // el servidor la rechaza y avisa
        if (!s && !algo) s = w.dataset.legacy || "";              // sin cambios: se conserva la anterior
        w.querySelector("input[type=hidden]").value = s;
        w.querySelector(".dir-vista").textContent = s || "—";
    }

    const inicial = (c) => c.defecto === "hoy"
        ? new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10)
        : (c.defecto ?? "");

    function entrada(c, v, bloqueado) {
        const id = "f-" + c.nombre, dis = bloqueado ? "disabled" : "", val = v ?? "";
        if (c.tipo === "direccion") return entradaDireccion(c, val, dis);
        if (c.fk || c.tipo === "select") {
            const ops = c.fk
                ? (DB[c.fk] || []).map((f) => [f[META[c.fk].pk[0]], etiquetaFila(c.fk, f)])
                : c.opciones.map((o) => [o, o.replace(/_/g, " ")]);
            if (val !== "" && !ops.some((o) => o[0] === val)) ops.push([val, val]);
            return `<select id="${id}" class="form-select" ${dis}>
                <option value="">— Seleccione —</option>
                ${ops.map(([k, t]) => `<option value="${esc(k)}" ${k === val ? "selected" : ""}>${esc(t)}</option>`).join("")}
            </select>`;
        }
        const largo = c.largo ? `maxlength="${c.largo}"` : "";
        if (c.tipo === "textarea")
            return `<textarea id="${id}" class="form-control" rows="3" ${largo} ${dis}>${esc(val)}</textarea>`;
        const t = { int: "number", float: "number", email: "email", date: "date", tel: "tel" }[c.tipo] || "text";
        const num = c.tipo === "int" || c.tipo === "float";
        const lim = num ? `min="${c.min ?? 0}" ${c.max != null ? `max="${c.max}"` : ""}` : "";
        const step = c.tipo === "float" ? 'step="any"' : c.tipo === "int" ? 'step="1"' : "";
        const extra = c.tipo === "tel" ? `inputmode="numeric" data-solo="tel"`
                    : c.tipo === "date" ? 'min="2000-01-01"' : "";
        // El precio de cada línea y el total de la factura los calcula SIEMPRE el servidor
        const calculado = c.auto && c.moneda;
        return `<input id="${id}" type="${t}" ${step} ${lim} ${largo} ${extra} class="form-control" value="${esc(val)}" ${calculado ? "disabled" : dis}
                ${calculado ? 'placeholder="Lo calcula el sistema"' : c.auto ? 'placeholder="Automático si lo dejas vacío"' : ""}>`;
    }

    function abrir(i) {
        const e = META[actual];
        editando = i === null ? null : DB[actual][i];
        $("modal-titulo").textContent = (editando ? "Editar: " : "Nuevo registro: ") + e.titulo;
        $("modal-error").textContent = "";

        let h = "";
        if (e.pk.length === 1) {
            h += campo("ID", `<input class="form-control" value="${esc(editando ? editando[e.pk[0]] : "")}"
                              disabled placeholder="Se asigna automáticamente">`);
        }
        for (const c of e.campos) {
            const bloq = editando && e.pk.includes(c.nombre);
            h += campo(c.etiqueta + (c.req ? " *" : ""), entrada(c, editando ? editando[c.nombre] : inicial(c), bloq));
        }
        if (actual === "factura_venta") h += `<div id="prev-factura" class="alert alert-secondary small mb-0"></div>`;
        $("modal-cuerpo").innerHTML = h;
        $("modal-cuerpo").querySelectorAll(".dir-widget").forEach((w) => dirCambio(w.querySelector("select")));
        if (actual === "factura_venta") previsualizarFactura();
        modal().show();
    }

    // Eventos del formulario (en vez de atributos onclick/oninput, para poder usar una política CSP estricta)
    $("modal-cuerpo").addEventListener("input", (ev) => {
        const el = ev.target;
        if (el.dataset.solo === "tel") el.value = el.value.replace(/[^0-9+ ()-]/g, "");
        if (el.dataset.d === "placa") el.value = el.value.replace(/[^0-9]/g, "");
        if (el.closest(".dir-widget") && el.dataset.d) dirCambio(el);
    });
    $("modal-cuerpo").addEventListener("change", (ev) => {
        const el = ev.target;
        if (el.closest(".dir-widget") && el.dataset.d) dirCambio(el);
        if (el.id === "f-id_pedido" && actual === "factura_venta") previsualizarFactura();
    });
    $("modal-cuerpo").addEventListener("input", (ev) => {
        if (ev.target.id === "f-estado_factura" && actual === "factura_venta") previsualizarFactura();
    });

    // Muestra, antes de guardar, cuánto se va a facturar y qué pasará con el inventario
    function previsualizarFactura() {
        const caja = $("prev-factura"), sel = $("f-id_pedido");
        if (!caja || !sel) return;
        const ls = por("producto_pedidos", "id_pedido", sel.value);
        if (!sel.value) { caja.textContent = "Elige un pedido: el total se calcula con sus productos."; return; }
        if (!ls.length) { caja.textContent = "Este pedido aún no tiene productos. Agrégalos en «Detalle de pedidos»."; return; }
        const filas = ls.map((l) => {
            const p = buscar("producto", l.id_prod) || {};
            const falta = p.stock_actual != null && p.stock_actual < l.cantidad;
            return `<li>${esc(etiqueta("producto", l.id_prod))}: ${esc(l.cantidad)} × ${dinero(p.precio_unitario ?? l.precio_unitario)} = <b>${dinero(l.cantidad * (p.precio_unitario ?? l.precio_unitario))}</b>`
                 + (falta ? ` <span class="text-danger fw-bold">(stock insuficiente: hay ${esc(p.stock_actual)})</span>` : ` <span class="text-secondary">(stock ${esc(p.stock_actual)} → ${esc(p.stock_actual - l.cantidad)})</span>`) + `</li>`;
        });
        const total = ls.reduce((t, l) => t + l.cantidad * ((buscar("producto", l.id_prod) || l).precio_unitario || 0), 0);
        caja.innerHTML = `<ul class="mb-2 ps-3">${filas.join("")}</ul><div class="fs-6">Total a facturar: <b>${dinero(total)}</b></div>`
            + (editando ? "" : `<div class="mt-1">Al guardar, estas unidades se descuentan del inventario.</div>`);
    }

    $("btn-guardar").onclick = async () => {
        const e = META[actual], datos = {};
        e.campos.forEach((c) => datos[c.nombre] = $("f-" + c.nombre).value);
        const clave = editando ? e.pk.map((p) => encodeURIComponent(editando[p])).join("~") : "";

        $("btn-guardar").disabled = true;
        try {
            await api("/api/" + actual + (editando ? "/" + clave : ""),
                { method: editando ? "PUT" : "POST", body: JSON.stringify(datos) });
            modal().hide();
            await cargar(recargar(actual));
            tabla();
        } catch (err) {
            $("modal-error").textContent = err.message;
        } finally {
            $("btn-guardar").disabled = false;
            $("btn-guardar").focus();   // el teclado (Esc, Tab) sigue funcionando dentro de la ventana
        }
    };

    async function borrar(i) {
        const e = META[actual], f = DB[actual][i];
        if (!confirm("¿Borrar este registro de forma permanente?")) return;
        try {
            await api("/api/" + actual + "/" + e.pk.map((p) => encodeURIComponent(f[p])).join("~"), { method: "DELETE" });
            await cargar(recargar(actual));
            tabla();
        } catch (err) { alert(err.message); }
    }

    // Qué tablas hay que volver a pedir al servidor después de guardar o borrar
    function recargar(ent) {
        const extra = { personas: ["clientes", "empleados"], factura_venta: ["producto", "producto_pedidos"] }[ent] || [];
        return [ent, ...extra];
    }

    // detalle de cada registro
    const SINGULAR = { pedido: "Pedido", producto_pedidos: "Línea de pedido", factura_venta: "Factura",
        clientes: "Cliente", producto: "Producto", materia_prima: "Materia prima",
        proveedor: "Proveedor", proveedor_materia: "Materia de proveedor", personas: "Persona",
        empleados: "Empleado", metodo_pago: "Método de pago" };
    const COLORES = { pendiente: "warning text-dark", en_proceso: "info text-dark", finalizado: "success",
        pagada: "success", cancelado: "danger", anulada: "danger" };
    let pila = [];   // historial de detalles abiertos (para el botón Volver)

    const clavePk = (e, f) => e.pk.map((p) => f[p]).join("~");
    const buscar = (ent, key) => (DB[ent] || []).find((f) => clavePk(META[ent], f) === key);
    const por = (ent, campo, id) => (DB[ent] || []).filter((r) => r[campo] === id);
    const persona = (id) => (DB.personas || []).find((p) => p.id_persona === id);
    const val = (x) => (x === null || x === undefined || x === "") ? '<span class="text-secondary">—</span>' : esc(x);
    const link = (ent, key, texto) => `<a href="#" class="ver" data-ent="${ent}" data-id="${esc(key)}">${esc(texto)}</a>`;
    const badge = (v) => v ? `<span class="badge bg-${COLORES[v] || "secondary"}">${esc(String(v).replace(/_/g, " "))}</span>` : val("");
    const alerta = (tipo, txt) => `<div class="alert alert-${tipo} py-2">${esc(txt)}</div>`;
    const subtotal = (l) => (l.cantidad || 0) * (l.precio_unitario || 0);
    const totalLineas = (ls) => ls.reduce((s, l) => s + subtotal(l), 0);
    const sumaFacturas = (fs) => fs.filter((x) => x.estado_factura !== "anulada")
                                   .reduce((s, x) => s + Number(x.total_factura || 0), 0);

    const ficha = (titulo, pares) => `
        <div class="card border-0 shadow-sm mb-3"><div class="card-header bg-white fw-bold">${esc(titulo)}</div>
            <div class="card-body"><div class="row g-3">
                ${pares.map(([k, h]) => `<div class="col-md-4"><div class="text-secondary small">${esc(k)}</div><div class="fw-semibold">${h}</div></div>`).join("")}
            </div></div></div>`;

    const tarjetas = (items) => `<div class="row g-3 mb-3">${items.map(([t, v]) => `
        <div class="col"><div class="card border-0 shadow-sm"><div class="card-body py-2">
            <div class="text-secondary small">${esc(t)}</div><div class="fs-5 fw-bold">${esc(String(v))}</div>
        </div></div></div>`).join("")}</div>`;

    const lista = (titulo, cab, filas, vacio, pie = "") => `
        <div class="card border-0 shadow-sm mb-3"><div class="card-header bg-white fw-bold">${esc(titulo)}</div>
            <div class="table-responsive"><table class="table table-sm align-middle m-0">
                <thead><tr>${cab.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>
                <tbody>${filas.length
                    ? filas.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")
                    : `<tr><td colspan="${cab.length}" class="text-center text-secondary py-3">${esc(vacio)}</td></tr>`}</tbody>
                ${pie ? `<tfoot>${pie}</tfoot>` : ""}
            </table></div></div>`;

    function fichaPersona(titulo, id) {
        const p = persona(id);
        if (!p) return "";
        return ficha(titulo, [
            ["Nombre", link("personas", p.id_persona, p.nombre)],
            ["Identificación", val(`${p.tipo_identificacion || ""} ${p.numero_identificacion || ""}`.trim())],
            ["Teléfono", val(p.telefono)], ["Correo", val(p.correo)], ["Dirección", val(p.direccion)],
        ]);
    }
    function fichaCliente(c) {
        const p = persona(c.id_persona) || {};
        return ficha("Cliente", [
            ["Cliente", link("clientes", c.id_cliente, etiqueta("clientes", c.id_cliente))],
            ["Identificación", val(`${p.tipo_identificacion || ""} ${p.numero_identificacion || ""}`.trim())],
            ["Teléfono", val(p.telefono)], ["Correo", val(p.correo)], ["Dirección", val(p.direccion)],
            ["Empleado asignado", c.id_empleado_asignado
                ? link("empleados", c.id_empleado_asignado, etiqueta("empleados", c.id_empleado_asignado)) : val("")],
        ]);
    }
    const tablaLineas = (ls) => lista("Productos del pedido", ["Producto", "Cantidad", "Precio unitario", "Subtotal"],
        ls.map((l) => [link("producto", l.id_prod, etiqueta("producto", l.id_prod)), esc(l.cantidad), dinero(l.precio_unitario), dinero(subtotal(l))]),
        "Este pedido aún no tiene productos. Agrégalos en «Detalle de pedidos».",
        `<tr class="fw-bold"><td colspan="3" class="text-end">Total</td><td>${dinero(totalLineas(ls))}</td></tr>`);
    const tablaFacturas = (titulo, fs) => lista(titulo, ["Factura", "Fecha", "Estado", "Método de pago", "Total"],
        fs.map((x) => [link("factura_venta", x.id_factura, x.id_factura), esc(x.fecha_factura), badge(x.estado_factura),
                       x.id_metodo ? esc(etiqueta("metodo_pago", x.id_metodo)) : val(""), dinero(x.total_factura)]),
        "Sin facturas");
    const tablaPedidos = (ps) => lista("Pedidos", ["Pedido", "Fecha", "Estado", "Total"],
        ps.map((p) => [link("pedido", p.id_pedido, p.numero_pedido || p.id_pedido), esc(p.fecha_pedido), badge(p.estado_pedido),
                       dinero(totalLineas(por("producto_pedidos", "id_pedido", p.id_pedido)))]),
        "Sin pedidos");

    // Secciones adicionales de cada módulo
    const DETALLE = {
        pedido: (f) => {
            const ls = por("producto_pedidos", "id_pedido", f.id_pedido);
            const facs = por("factura_venta", "id_pedido", f.id_pedido);
            const cli = (DB.clientes || []).find((c) => c.id_cliente === f.id_cliente);
            return [
                f.estado_pedido === "finalizado" && !facs.length ? alerta("warning", "Este pedido está finalizado pero no tiene factura.") : "",
                tarjetas([["Total del pedido", dinero(totalLineas(ls))], ["Productos distintos", ls.length],
                          ["Unidades", ls.reduce((s, l) => s + (l.cantidad || 0), 0)], ["Facturado", dinero(sumaFacturas(facs))]]),
                cli ? fichaCliente(cli) : "",
                tablaLineas(ls),
                tablaFacturas("Facturas del pedido", facs),
            ];
        },
        factura_venta: (f) => {
            const ped = (DB.pedido || []).find((p) => p.id_pedido === f.id_pedido);
            const ls = ped ? por("producto_pedidos", "id_pedido", ped.id_pedido) : [];
            const cli = ped ? (DB.clientes || []).find((c) => c.id_cliente === ped.id_cliente) : null;
            const difiere = ped && Math.abs(Number(f.total_factura) - totalLineas(ls)) > 0.5;
            return [
                `<div class="mb-3"><button class="btn btn-primary btn-sm" data-factura="${esc(f.id_factura)}"><i class="bi bi-printer me-1"></i>Ver e imprimir factura</button></div>`,
                difiere ? alerta("warning", "El total facturado no coincide con la suma de los productos del pedido. Abre «Editar» y guarda la factura para recalcularlo.") : "",
                tarjetas([["Total facturado", dinero(f.total_factura)], ["Total según el pedido", dinero(totalLineas(ls))]]),
                cli ? fichaCliente(cli) : "",
                tablaLineas(ls),
            ];
        },
        clientes: (f) => {
            const peds = por("pedido", "id_cliente", f.id_cliente);
            const ids = peds.map((p) => p.id_pedido);
            const facs = (DB.factura_venta || []).filter((x) => ids.includes(x.id_pedido));
            return [
                fichaPersona("Datos de la persona", f.id_persona),
                tarjetas([["Pedidos", peds.length], ["Total en pedidos", dinero(totalLineas((DB.producto_pedidos || []).filter((l) => ids.includes(l.id_pedido))))],
                          ["Total facturado", dinero(sumaFacturas(facs))]]),
                tablaPedidos(peds),
            ];
        },
        personas: (f) => {
            const cl = por("clientes", "id_persona", f.id_persona), em = por("empleados", "id_persona", f.id_persona);
            return [lista("Roles en el sistema", ["Rol", "Registro"],
                [...cl.map((c) => ["Cliente", link("clientes", c.id_cliente, c.id_cliente)]),
                 ...em.map((x) => ["Empleado", link("empleados", x.id_empleado, `${x.id_empleado} · ${x.tipo_cargo || ""}`)])],
                "Esta persona no es cliente ni empleado")];
        },
        empleados: (f) => {
            const cls = por("clientes", "id_empleado_asignado", f.id_empleado);
            const facs = por("factura_venta", "id_empleado", f.id_empleado);
            return [
                fichaPersona("Datos de la persona", f.id_persona),
                tarjetas([["Clientes asignados", cls.length], ["Facturas emitidas", facs.length], ["Total facturado", dinero(sumaFacturas(facs))]]),
                lista("Clientes asignados", ["Cliente", "Teléfono"],
                    cls.map((c) => [link("clientes", c.id_cliente, etiqueta("clientes", c.id_cliente)), val((persona(c.id_persona) || {}).telefono)]),
                    "Sin clientes asignados"),
                tablaFacturas("Facturas emitidas", facs),
            ];
        },
        producto: (f) => {
            const ls = por("producto_pedidos", "id_prod", f.id_prod);
            const bajo = f.cantidad_min != null && f.stock_actual <= f.cantidad_min;
            return [
                bajo ? alerta("danger", "El stock está en el mínimo o por debajo: conviene producir o reponer.") : "",
                tarjetas([["Stock actual", f.stock_actual], ["Mínimo / máximo", `${f.cantidad_min} / ${f.cantidad_max}`],
                          ["Unidades en pedidos", ls.reduce((s, l) => s + (l.cantidad || 0), 0)]]),
                lista("Pedidos que lo incluyen", ["Pedido", "Cantidad", "Precio unitario"],
                    ls.map((l) => [link("pedido", l.id_pedido, etiqueta("pedido", l.id_pedido)), esc(l.cantidad), dinero(l.precio_unitario)]),
                    "Aún no se ha pedido"),
            ];
        },
        materia_prima: (f) => [lista("Proveedores que la suministran (del más barato al más caro)", ["Proveedor", "Precio de compra"],
            por("proveedor_materia", "id_materia", f.id_materia).sort((a, b) => a.precio_compra - b.precio_compra)
                .map((p) => [link("proveedor", p.id_prov, etiqueta("proveedor", p.id_prov)), dinero(p.precio_compra)]),
            "Sin proveedores registrados")],
        proveedor: (f) => [lista("Materia prima que suministra", ["Material", "Precio de compra", "Stock actual"],
            por("proveedor_materia", "id_prov", f.id_prov).map((x) => { const m = buscar("materia_prima", x.id_materia) || {};
                return [link("materia_prima", x.id_materia, etiqueta("materia_prima", x.id_materia)), dinero(x.precio_compra),
                        esc(`${m.stock_actual ?? ""} ${m.unidad_medida || ""}`)]; }),
            "Aún no tiene materias asociadas")],
        metodo_pago: (f) => {
            const facs = por("factura_venta", "id_metodo", f.id_metodo);
            return [tarjetas([["Facturas", facs.length], ["Total facturado", dinero(sumaFacturas(facs))]]),
                    tablaFacturas("Facturas pagadas con este método", facs)];
        },
        producto_pedidos: (f) => {
            const ped = (DB.pedido || []).find((p) => p.id_pedido === f.id_pedido), pr = (DB.producto || []).find((p) => p.id_prod === f.id_prod);
            return [
                tarjetas([["Subtotal de la línea", dinero(subtotal(f))]]),
                ped ? ficha("Pedido", [["Pedido", link("pedido", ped.id_pedido, ped.numero_pedido || ped.id_pedido)], ["Fecha", val(ped.fecha_pedido)],
                    ["Estado", badge(ped.estado_pedido)], ["Cliente", link("clientes", ped.id_cliente, etiqueta("clientes", ped.id_cliente))]]) : "",
                pr ? ficha("Producto", [["Producto", link("producto", pr.id_prod, pr.nombre_pro)], ["Precio actual", dinero(pr.precio_unitario)],
                    ["Stock", val(pr.stock_actual)]]) : "",
            ];
        },
        proveedor_materia: (f) => {
            const p = (DB.proveedor || []).find((x) => x.id_prov === f.id_prov), m = (DB.materia_prima || []).find((x) => x.id_materia === f.id_materia);
            return [
                p ? ficha("Proveedor", [["Proveedor", link("proveedor", p.id_prov, p.nombre)], ["Teléfono", val(p.telefono)],
                    ["Correo", val(p.correo)], ["Dirección", val(p.direccion)]]) : "",
                m ? ficha("Materia prima", [["Material", link("materia_prima", m.id_materia, m.nombre_materia)],
                    ["Stock", esc(`${m.stock_actual} ${m.unidad_medida}`)]]) : "",
            ];
        },
    };

    function tituloFila(ent, f) {
        const e = META[ent];
        if (e.etiqueta) return etiquetaFila(ent, f) || f[e.pk[0]];
        return e.pk.map((p) => { const c = e.campos.find((x) => x.nombre === p); return c && c.fk ? etiqueta(c.fk, f[p]) : f[p]; }).join(" · ");
    }

    function verDetalle(ent, key, volver = false) {
        const e = META[ent], f = buscar(ent, key);
        if (!f) return;
        if (!volver) pila.push({ ent, key });
        const pares = e.pk.length === 1 ? [["ID", esc(key)]] : [];
        for (const c of e.campos) {
            const v = f[c.nombre];
            let h;
            if (v === null || v === undefined || v === "") h = val("");
            else if (c.fk) h = link(c.fk, v, etiqueta(c.fk, v));
            else if (c.tipo === "select" && c.nombre.startsWith("estado")) h = badge(v);
            else h = esc(valor(c, f));
            pares.push([c.etiqueta, h]);
        }
        $("det-titulo").textContent = SINGULAR[ent] + ": " + tituloFila(ent, f);
        $("det-cuerpo").innerHTML = ficha("Información general", pares) + (DETALLE[ent] ? DETALLE[ent](f).join("") : "");
        $("det-cuerpo").scrollTop = 0;
        $("det-atras").classList.toggle("d-none", pila.length < 2);
        bootstrap.Modal.getOrCreateInstance($("modal-detalle")).show();
    }

    function detalleFila(i) { verDetalle(actual, clavePk(META[actual], DB[actual][i])); }

    $("det-cuerpo").addEventListener("click", (ev) => {
        const bf = ev.target.closest("[data-factura]");
        if (bf) {
            const el = $("modal-detalle");
            el.addEventListener("hidden.bs.modal", () => verFactura(bf.dataset.factura), { once: true });
            bootstrap.Modal.getOrCreateInstance(el).hide();
            return;
        }
        const a = ev.target.closest("a.ver");
        if (!a) return;
        ev.preventDefault();
        verDetalle(a.dataset.ent, a.dataset.id);
    });
    $("det-atras").onclick = () => {
        pila.pop();
        const p = pila[pila.length - 1];
        if (p) verDetalle(p.ent, p.key, true);
    };
    $("modal-detalle").addEventListener("hidden.bs.modal", () => { pila = []; });

    // arranque
    (async function init() {
        if (!token) return;
        try {
            META = await api("/api/meta");
            menu();
            await cargar();
            ir("resumen");
        } catch (err) {
            $("vista").innerHTML = `<div class="alert alert-danger">No se pudo cargar el sistema: ${esc(err.message)}.
                Verifica que el servidor de Python esté encendido y que las tablas existan en Supabase.</div>`;
        }
    })();


    // menú lateral en celulares y tabletas
    $("btn-menu").onclick = () => document.body.classList.toggle("menu-abierto");
    $("menu-fondo").onclick = () => document.body.classList.remove("menu-abierto");

    // nombre del usuario: viene dentro del token (campo "sub")
    try {
        const carga = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
        $("usuario-actual").textContent = "Sesión: " + carga.sub;
    } catch (e) { /* si el token no se puede leer, simplemente no se muestra */ }

    // ---------- Factura: vista previa e impresión ----------
    function facturaHTML(f) {
        const ped = (DB.pedido || []).find((p) => p.id_pedido === f.id_pedido) || {};
        const cli = (DB.clientes || []).find((c) => c.id_cliente === ped.id_cliente) || {};
        const per = persona(cli.id_persona) || {};
        const emp = f.id_empleado ? etiqueta("empleados", f.id_empleado) : "";
        const met = f.id_metodo ? etiqueta("metodo_pago", f.id_metodo) : "";
        const ls = por("producto_pedidos", "id_pedido", f.id_pedido);
        const estado = String(f.estado_factura || "").toUpperCase();
        const dato = (k, v) => `<div><span>${esc(k)}</span><b>${v ? esc(v) : "—"}</b></div>`;
        const difiere = Math.abs(Number(f.total_factura) - totalLineas(ls)) > 0.5;
        return `
        <article class="factura-hoja ${f.estado_factura === "anulada" ? "anulada" : ""}">
            <header class="factura-cab">
                <img src="img/camion.png" alt="" class="factura-logo">
                <div class="factura-empresa"><h2>Universal de Partes y Soportes</h2><p>Factura de venta</p></div>
                <div class="factura-num"><span>Factura N.º</span><b>${esc(f.id_factura)}</b><small>${esc(f.fecha_factura)}</small></div>
            </header>
            <div class="factura-estado estado-${esc(f.estado_factura)}">${esc(estado)}</div>
            <section class="factura-datos">
                <div class="factura-bloque"><h3>Cliente</h3>
                    ${dato("Nombre", per.nombre)}${dato("Identificación", `${per.tipo_identificacion || ""} ${per.numero_identificacion || ""}`.trim())}
                    ${dato("Teléfono", per.telefono)}${dato("Correo", per.correo)}${dato("Dirección", per.direccion)}
                </div>
                <div class="factura-bloque"><h3>Venta</h3>
                    ${dato("Pedido", ped.numero_pedido || f.id_pedido)}${dato("Fecha del pedido", ped.fecha_pedido)}
                    ${dato("Atendido por", emp)}${dato("Método de pago", met)}
                </div>
            </section>
            <table class="factura-tabla">
                <thead><tr><th>Producto</th><th class="num">Cant.</th><th class="num">Precio unitario</th><th class="num">Subtotal</th></tr></thead>
                <tbody>${ls.length ? ls.map((l) => `<tr><td>${esc(etiqueta("producto", l.id_prod))}</td><td class="num">${esc(l.cantidad)}</td>
                    <td class="num">${dinero(l.precio_unitario)}</td><td class="num">${dinero(subtotal(l))}</td></tr>`).join("")
                    : `<tr><td colspan="4" class="vacio">Sin productos</td></tr>`}</tbody>
                <tfoot><tr><td colspan="3" class="num">TOTAL</td><td class="num total">${dinero(f.total_factura)}</td></tr></tfoot>
            </table>
            ${difiere ? `<p class="factura-aviso sin-imprimir">Aviso: el total guardado (${dinero(f.total_factura)}) no coincide con la suma de los productos (${dinero(totalLineas(ls))}). Edita y guarda la factura para recalcularlo.</p>` : ""}
            <footer class="factura-pie">Gracias por su compra.</footer>
        </article>`;
    }

    let facturaAbierta = null;
    function verFactura(id) {
        const f = buscar("factura_venta", id);
        if (!f) return;
        facturaAbierta = f;
        $("fac-cuerpo").innerHTML = facturaHTML(f);
        bootstrap.Modal.getOrCreateInstance($("modal-factura")).show();
    }

    // Imprime en un marco oculto (no lo bloquea el bloqueador de ventanas emergentes)
    $("btn-imprimir").onclick = () => {
        if (!facturaAbierta) return;
        const marco = document.createElement("iframe");
        marco.setAttribute("aria-hidden", "true");
        marco.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
        document.body.appendChild(marco);
        const d = marco.contentDocument;
        const css = new URL("css/estilos.css", location.href).href;
        const logo = new URL("img/camion.png", location.href).href;
        d.open();
        d.write(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>Factura ${esc(facturaAbierta.id_factura)}</title>
            <link rel="stylesheet" href="${css}"></head><body class="impresion">${facturaHTML(facturaAbierta).replace('src="img/camion.png"', `src="${logo}"`)}</body></html>`);
        d.close();
        let hecho = false;
        const imprimir = () => {
            if (hecho) return; hecho = true;
            marco.contentWindow.focus(); marco.contentWindow.print();
            setTimeout(() => marco.remove(), 1500);
        };
        const esperar = [...d.querySelectorAll("img"), ...d.querySelectorAll("link")];
        let faltan = esperar.length;
        const listo = () => { if (--faltan <= 0) imprimir(); };
        esperar.forEach((el) => { el.addEventListener("load", listo); el.addEventListener("error", listo); });
        setTimeout(imprimir, 1500);      // por si algún recurso tarda demasiado
    };

    // ---------- Cambiar contraseña ----------
    $("btn-clave").onclick = () => {
        $("form-clave").reset();
        $("btn-enviar-codigo").disabled = false; $("btn-enviar-codigo").textContent = "Enviar código";
        $("clave-msg").textContent = "";
        $("clave-msg").className = "small mt-2";
        bootstrap.Modal.getOrCreateInstance($("modal-clave")).show();
    };
    $("modal-clave").addEventListener("shown.bs.modal", () => $("clave-actual").focus());
    $("clave-codigo").addEventListener("input", (e) => { e.target.value = e.target.value.replace(/\D/g, "").slice(0, 6); });

    // Paso de verificación: el servidor manda un código de 6 dígitos al correo registrado
    $("btn-enviar-codigo").onclick = async () => {
        const msg = $("clave-msg"), b = $("btn-enviar-codigo");
        b.disabled = true;
        try {
            const d = await api("/api/cuenta/clave/codigo", { method: "POST" });
            msg.className = "small mt-2 text-success fw-bold";
            msg.textContent = "Te enviamos un código a " + d.destino + ". Vence en 10 minutos.";
            $("clave-codigo").focus();
            setTimeout(() => { b.disabled = false; b.textContent = "Reenviar código"; }, 30000);
        } catch (e) {
            msg.className = "small mt-2 text-danger"; msg.textContent = e.message; b.disabled = false;
        }
    };
    $("form-clave").addEventListener("submit", async (ev) => {
        ev.preventDefault();
        const msg = $("clave-msg"), btn = $("btn-clave-ok");
        const error = (t) => { msg.className = "small mt-2 text-danger"; msg.textContent = t; };
        const act = $("clave-actual").value, nueva = $("clave-nueva").value, rep = $("clave-repite").value, cod = $("clave-codigo").value.trim();
        if (!act || !nueva || !rep) return error("Completa los tres campos de contraseña.");
        if (!/^\d{6}$/.test(cod)) return error("Pulsa «Enviar código» y escribe el código de 6 dígitos que llegó a tu correo.");
        if (nueva !== rep) return error("La contraseña nueva y su repetición no coinciden.");
        if (nueva.length < 10) return error("La contraseña nueva debe tener al menos 10 caracteres.");
        if (!(/[a-z]/.test(nueva) && /[A-Z]/.test(nueva) && /\d/.test(nueva)))
            return error("La contraseña nueva debe mezclar mayúsculas, minúsculas y números.");
        btn.disabled = true;
        try {
            const d = await api("/api/cuenta/clave", { method: "POST", body: JSON.stringify({ clave_actual: act, clave_nueva: nueva, codigo: cod }) });
            token = d.token;                                   // el servidor entrega una sesión nueva
            sessionStorage.setItem("token", token);
            $("form-clave").reset();
            msg.className = "small mt-2 text-success fw-bold";
            msg.textContent = "Contraseña cambiada correctamente.";
            setTimeout(() => bootstrap.Modal.getOrCreateInstance($("modal-clave")).hide(), 1200);
        } catch (e) { error(e.message); }
        finally { btn.disabled = false; }
    });
    $("btn-salir").onclick = () => salir();

