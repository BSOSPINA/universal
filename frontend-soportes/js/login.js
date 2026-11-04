    // Si la página la sirve el propio servidor (local o en Internet) las rutas son relativas.
    // Solo si abres el HTML con doble clic (file://) apunta al servidor local.
    const API = location.protocol === "file:" ? "https://universal-r9da.onrender.com" : "";

    if (sessionStorage.getItem("token")) location.href = "index.html";

    const err = document.getElementById("error");
    const mostrar = (txt) => { err.textContent = txt; err.classList.remove("d-none"); err.style.color = err.style.background = err.style.borderLeftColor = ""; };

    const motivo = new URLSearchParams(location.search).get("motivo");
    if (motivo === "inactividad") mostrar("Tu sesión se cerró por inactividad. Entra de nuevo.");
    else if (motivo === "expirada") mostrar("Tu sesión expiró. Entra de nuevo.");

    document.getElementById("form").addEventListener("submit", async (ev) => {
        ev.preventDefault();
        const btn = document.getElementById("btn");
        err.classList.add("d-none");
        btn.disabled = true;

        try {
            const r = await fetch(API + "/login", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    usuario: document.getElementById("usuario").value.trim(),
                    clave: document.getElementById("clave").value
                })
            });
            const d = await r.json().catch(() => ({}));

            if (r.ok && d.token) {
                sessionStorage.setItem("token", d.token);
                document.getElementById("clave").value = "";
                location.href = "index.html";
                return;
            }
            document.getElementById("clave").value = "";
            mostrar(typeof d.detail === "string" ? d.detail : "Usuario o contraseña incorrectos");
        } catch (e) {
            mostrar("No se pudo conectar con el servidor. Revisa que esté encendido e inténtalo de nuevo.");
        } finally {
            btn.disabled = false;
        }
    });

    // ---------- Cambiar contraseña desde el login: siempre con código enviado al correo ----------
    const formLogin = document.getElementById("form"), formClave = document.getElementById("form-clave");
    const msg = document.getElementById("c-msg"), btnC = document.getElementById("c-btn");
    const $ = (id) => document.getElementById(id);
    let paso = 1;

    const aviso = (t, ok) => {
        msg.textContent = t; msg.classList.remove("d-none");
        msg.style.color = ok ? "var(--galvanizado)" : ""; msg.style.background = ok ? "#E8F4EE" : ""; msg.style.borderLeftColor = ok ? "var(--galvanizado)" : "";
    };
    const irPaso = (n) => {
        paso = n;
        $("paso-1").classList.toggle("d-none", n !== 1);
        $("paso-2").classList.toggle("d-none", n !== 2);
        $("reenviar").classList.toggle("d-none", n !== 2);
        btnC.textContent = n === 1 ? "Enviar código" : "Guardar contraseña";
        msg.classList.add("d-none");
    };
    const alternar = (verClave) => {
        formLogin.classList.toggle("d-none", verClave);
        formClave.classList.toggle("d-none", !verClave);
        err.classList.add("d-none");
        if (verClave) { formClave.reset(); irPaso(1); }
        $(verClave ? "c-usuario" : "usuario").focus();
    };
    $("ir-clave").onclick = () => alternar(true);
    $("volver-login").onclick = () => alternar(false);
    $("c-codigo").addEventListener("input", (e) => { e.target.value = e.target.value.replace(/\D/g, "").slice(0, 6); });

    async function pedirCodigo() {
        const usuario = $("c-usuario").value.trim();
        if (!usuario) return aviso("Escribe tu usuario.");
        btnC.disabled = true;
        try {
            const r = await fetch(API + "/recuperar/solicitar", {
                method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ usuario })
            });
            const d = await r.json().catch(() => ({}));
            if (!r.ok) return aviso(typeof d.detail === "string" ? d.detail : "No se pudo enviar el código.");
            irPaso(2);
            aviso(d.mensaje, true);
            $("c-codigo").focus();
        } catch (e) { aviso("No se pudo conectar con el servidor."); }
        finally { btnC.disabled = false; }
    }
    $("reenviar").onclick = pedirCodigo;

    formClave.addEventListener("submit", async (ev) => {
        ev.preventDefault();
        if (paso === 1) return pedirCodigo();

        const usuario = $("c-usuario").value.trim(), codigo = $("c-codigo").value.trim();
        const nueva = $("c-nueva").value, repite = $("c-repite").value;
        if (!/^\d{6}$/.test(codigo)) return aviso("Escribe el código de 6 dígitos que llegó a tu correo.");
        if (nueva !== repite) return aviso("La contraseña nueva y su repetición no coinciden.");
        if (nueva.length < 10) return aviso("La contraseña nueva debe tener al menos 10 caracteres.");
        if (!(/[a-z]/.test(nueva) && /[A-Z]/.test(nueva) && /\d/.test(nueva)))
            return aviso("La contraseña nueva debe mezclar mayúsculas, minúsculas y números.");
        btnC.disabled = true;
        try {
            const r = await fetch(API + "/recuperar/confirmar", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ usuario, codigo, clave_nueva: nueva })
            });
            const d = await r.json().catch(() => ({}));
            if (r.ok) {
                formClave.reset();
                alternar(false);
                $("usuario").value = usuario;
                err.textContent = "Contraseña cambiada. Ya puedes entrar con la nueva.";
                err.classList.remove("d-none");
                err.style.color = "var(--galvanizado)"; err.style.background = "#E8F4EE"; err.style.borderLeftColor = "var(--galvanizado)";
                $("clave").focus();
                return;
            }
            aviso(typeof d.detail === "string" ? d.detail : "No se pudo cambiar la contraseña.");
        } catch (e) { aviso("No se pudo conectar con el servidor."); }
        finally { btnC.disabled = false; }
    });
