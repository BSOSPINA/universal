// Manejo de la sesión (se carga ANTES de login.js y app.js).
// El token vive en sessionStorage: el navegador lo borra solo al cerrar la pestaña,
// así que si cierras sin pulsar «Salir», la sesión queda cerrada.
(function () {
    const T = "token", C = "cierre";
    localStorage.removeItem(T);                      // restos de la versión anterior (quedaba guardado para siempre)

    // Si la pestaña se "reabre" (Ctrl+Mayús+T) el navegador devuelve sessionStorage: lo detectamos
    // porque la página se cerró hace más de unos segundos, y en ese caso se descarta el token.
    const cierre = Number(sessionStorage.getItem(C) || 0);
    sessionStorage.removeItem(C);
    if (cierre && Date.now() - cierre > 15000) sessionStorage.removeItem(T);

    addEventListener("pagehide", (ev) => {
        if (!ev.persisted && sessionStorage.getItem(T)) sessionStorage.setItem(C, String(Date.now()));
    });
})();
