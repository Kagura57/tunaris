const root = document.querySelector<HTMLDivElement>("#app");

function localFallbackRoomCode(length = 6): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let index = 0; index < length; index += 1) {
    const randomIndex = Math.floor(Math.random() * alphabet.length);
    const char = alphabet[randomIndex];
    if (char) {
      code += char;
    }
  }
  return code;
}

async function createRoom() {
  const response = await fetch("http://127.0.0.1:3001/quiz/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });

  if (!response.ok) {
    throw new Error("Create room failed");
  }

  const payload = (await response.json()) as { roomCode?: unknown };
  return typeof payload.roomCode === "string" ? payload.roomCode : localFallbackRoomCode();
}

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
    createRoomButton.addEventListener("click", async () => {
      status.textContent = "Création de la room...";
      try {
        const roomCode = await createRoom();
        status.textContent = `Room créée : ${roomCode}`;
      } catch {
        const fallback = localFallbackRoomCode();
        status.textContent = `Room créée (fallback) : ${fallback}`;
      }
    });
  }
}
