import { initHelpdeskNotifications } from "./src/tabs/helpdesk.js";
import { switchTab } from "./src/ui.js";

// Registra o Service Worker para habilitar o PWA
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then((registration) => {
        console.log('PWA Service Worker registrado com sucesso:', registration.scope);
      })
      .catch((error) => {
        console.error('Falha ao registrar o PWA Service Worker:', error);
      });
  });
}


export async function init() {
  initHelpdeskNotifications();
  switchTab("daily-ops");
}