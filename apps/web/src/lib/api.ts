const API_BASE_URL = "http://127.0.0.1:3001";

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

export async function createRoomWithFallback() {
  try {
    const response = await fetch(`${API_BASE_URL}/quiz/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    if (!response.ok) {
      throw new Error("CREATE_ROOM_HTTP_ERROR");
    }

    const payload = (await response.json()) as { roomCode?: unknown };
    if (typeof payload.roomCode === "string" && payload.roomCode.length > 0) {
      return { roomCode: payload.roomCode, source: "api" as const };
    }
  } catch {
    // Ignore and fallback to local mock room code for dev UX.
  }

  return { roomCode: localFallbackRoomCode(), source: "fallback" as const };
}
