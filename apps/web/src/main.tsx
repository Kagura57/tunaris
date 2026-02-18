const root = document.querySelector<HTMLDivElement>("#app");

if (root) {
  root.innerHTML = `
    <main style="font-family: system-ui, -apple-system, sans-serif; max-width: 720px; margin: 40px auto; padding: 0 16px;">
      <h1>Tunaris</h1>
      <p>Serveur web démarré avec succès.</p>
      <button id="create-room" style="padding: 10px 14px; border-radius: 8px; border: 1px solid #111; background: #111; color: #fff;">
        Créer une room
      </button>
      <p id="status" style="margin-top: 12px; color: #444;">En attente d'action...</p>
    </main>
  `;

  const createRoomButton = document.querySelector<HTMLButtonElement>("#create-room");
  const status = document.querySelector<HTMLParagraphElement>("#status");

  if (createRoomButton && status) {
    createRoomButton.addEventListener("click", () => {
      status.textContent = "Room créée (demo).";
    });
  }
}
