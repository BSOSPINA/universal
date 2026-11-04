// Agrega un botón con forma de ojo a cada campo de contraseña para ver u ocultar lo que se escribe.
(function () {
    function ocultarTodo() {
        document.querySelectorAll("input[data-ojo]").forEach((inp) => {
            inp.type = "password";
            const b = inp.parentElement.querySelector(".btn-ojo");
            if (b) { b.setAttribute("aria-pressed", "false"); b.setAttribute("aria-label", "Mostrar contraseña");
                     b.title = "Mostrar contraseña"; b.firstElementChild.className = "bi bi-eye"; }
        });
    }

    function envolver(inp) {
        if (inp.dataset.ojo) return;
        inp.dataset.ojo = "1";
        const grupo = document.createElement("div");
        grupo.className = "input-group";
        inp.parentNode.insertBefore(grupo, inp);
        grupo.appendChild(inp);

        const b = document.createElement("button");
        b.type = "button";
        b.className = "btn btn-secondary btn-ojo";
        b.title = "Mostrar contraseña";
        b.setAttribute("aria-label", "Mostrar contraseña");
        b.setAttribute("aria-pressed", "false");
        b.innerHTML = '<i class="bi bi-eye" aria-hidden="true"></i>';
        b.addEventListener("click", () => {
            const ver = inp.type === "password";
            inp.type = ver ? "text" : "password";
            b.setAttribute("aria-pressed", String(ver));
            b.setAttribute("aria-label", ver ? "Ocultar contraseña" : "Mostrar contraseña");
            b.title = ver ? "Ocultar contraseña" : "Mostrar contraseña";
            b.firstElementChild.className = ver ? "bi bi-eye-slash" : "bi bi-eye";
            inp.focus();
        });
        grupo.appendChild(b);
    }

    function iniciar() {
        document.querySelectorAll('input[type="password"]').forEach(envolver);
        // Al cerrar una ventana o cambiar de formulario, las contraseñas vuelven a ocultarse
        document.addEventListener("hidden.bs.modal", ocultarTodo);
        document.addEventListener("reset", () => setTimeout(ocultarTodo));
        document.addEventListener("click", (ev) => {
            if (ev.target.closest("#ir-clave, #volver-login")) ocultarTodo();
        });
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", iniciar);
    else iniciar();
})();
