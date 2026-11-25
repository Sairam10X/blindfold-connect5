const GRID_SIZE = 15;
const WIN_LENGTH = 5;
const DIRECTIONS = [
  [1, 0],  // horizontal
  [0, 1],  // vertical
  [1, 1],  // diagonal down-right
  [1, -1], // diagonal up-right
];

function createEmptyBoard() {
  return Array.from({ length: GRID_SIZE }, () => Array(GRID_SIZE).fill(0));
}

function createInitialGame() {
  return {
    players: [],
    names: ["", ""],
    starter: 1,
    turn: 1,
    winner: null,
    line: null,
    moves: [],
    board: createEmptyBoard(),
  };
}

function sanitizeName(raw) {
  if (typeof raw !== "string") return "";
  return raw.trim().replace(/\s+/g, " ").slice(0, 24);
}

function inBounds(x, y) {
  return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && x < GRID_SIZE && y >= 0 && y < GRID_SIZE;
}

function findWinningLine(board, x, y, player) {
  for (const [dx, dy] of DIRECTIONS) {
    const coords = [[x, y]];

    let cx = x - dx;
    let cy = y - dy;
    while (inBounds(cx, cy) && board[cy][cx] === player) {
      coords.unshift([cx, cy]);
      cx -= dx;
      cy -= dy;
    }

    cx = x + dx;
    cy = y + dy;
    while (inBounds(cx, cy) && board[cy][cx] === player) {
      coords.push([cx, cy]);
      cx += dx;
      cy += dy;
    }

    if (coords.length >= WIN_LENGTH) {
      return coords;
    }
  }
  return null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const wsMatch = url.pathname.match(/^\/ws\/([A-Za-z]{4})$/);

    if (wsMatch) {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("Expected WebSocket upgrade", { status: 426 });
      }

      const token = url.searchParams.get("t");
      if (!token || token.length > 128) {
        return new Response("Missing or invalid token", { status: 400 });
      }

      const code = wsMatch[1].toUpperCase();
      const id = env.ROOM.idFromName(code);
      const stub = env.ROOM.get(id);
      return stub.fetch(request);
    }

    return env.ASSETS.fetch(request);
  },
};

export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.game = null;
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get("game");
      this.game = stored || createInitialGame();
    });
  }

  async fetch(request) {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    const url = new URL(request.url);
    const token = url.searchParams.get("t");
    if (!token || token.length > 128) {
      return new Response("Invalid token", { status: 400 });
    }

    let seat = this.game.players.indexOf(token) + 1;
    let dirty = false;
    if (seat === 0) {
      if (this.game.players.length >= 2) {
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);
        server.accept();
        server.send(JSON.stringify({ type: "full" }));
        server.close(4003, "Room is full");
        return new Response(null, { status: 101, webSocket: client });
      }

      this.game.players.push(token);
      seat = this.game.players.length;
      dirty = true;
    }

    if (!Array.isArray(this.game.names)) {
      this.game.names = ["", ""];
    }
    const cleanName = sanitizeName(url.searchParams.get("name"));
    if (cleanName && this.game.names[seat - 1] !== cleanName) {
      this.game.names[seat - 1] = cleanName;
      dirty = true;
    }

    if (dirty) {
      await this.state.storage.put("game", this.game);
    }

    // Close any prior socket belonging to the same seat so stale connections don't linger
    for (const existing of this.state.getWebSockets()) {
      const att = existing.deserializeAttachment();
      if (att && att.seat === seat) {
        try {
          existing.close(4000, "Replaced by new connection");
        } catch {
          // Ignore already-closed sockets
        }
      }
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ seat });

    this.broadcastState();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== "string") return;

    let data;
    try {
      data = JSON.parse(message);
    } catch {
      return;
    }

    const att = ws.deserializeAttachment();
    const seat = att?.seat;
    if (seat !== 1 && seat !== 2) return;

    if (data.type === "move") {
      if (this.game.players.length < 2) return;
      if (this.game.winner !== null) return;
      if (this.game.turn !== seat) return;

      const { x, y } = data;
      if (!inBounds(x, y)) return;

      if (this.game.board[y][x] !== 0) {
        ws.send(JSON.stringify({ type: "taken", x, y }));
        return;
      }

      this.game.board[y][x] = seat;
      this.game.moves.push({ p: seat, x, y });

      const winLine = findWinningLine(this.game.board, x, y, seat);
      if (winLine) {
        this.game.winner = seat;
        this.game.line = winLine;
      } else if (this.game.moves.length === GRID_SIZE * GRID_SIZE) {
        this.game.winner = 0;
        this.game.line = null;
      } else {
        this.game.turn = seat === 1 ? 2 : 1;
      }

      await this.state.storage.put("game", this.game);
      this.broadcastState();
    } else if (data.type === "rematch") {
      if (this.game.players.length < 2) return;
      if (this.game.winner === null) return;

      this.game.starter = this.game.starter === 1 ? 2 : 1;
      this.game.turn = this.game.starter;
      this.game.winner = null;
      this.game.line = null;
      this.game.moves = [];
      this.game.board = createEmptyBoard();

      await this.state.storage.put("game", this.game);
      this.broadcastState();
    } else if (data.type === "name") {
      if (!Array.isArray(this.game.names)) {
        this.game.names = ["", ""];
      }
      const cleanName = sanitizeName(data.name);
      if (this.game.names[seat - 1] !== cleanName) {
        this.game.names[seat - 1] = cleanName;
        await this.state.storage.put("game", this.game);
        this.broadcastState();
      }
    }
  }

  async webSocketClose(ws) {
    this.broadcastState(ws);
  }

  async webSocketError(ws) {
    this.broadcastState(ws);
  }

  broadcastState(excludeWs = null) {
    const sockets = this.state.getWebSockets();
    const online = [false, false];

    for (const ws of sockets) {
      if (ws === excludeWs) continue;
      const att = ws.deserializeAttachment();
      if (att && (att.seat === 1 || att.seat === 2)) {
        online[att.seat - 1] = true;
      }
    }

    const ready = this.game.players.length === 2;
    const isOver = this.game.winner !== null;

    for (const ws of sockets) {
      if (ws === excludeWs) continue;
      const att = ws.deserializeAttachment();
      if (!att || (att.seat !== 1 && att.seat !== 2)) continue;

      const payload = {
        type: "state",
        you: att.seat,
        turn: this.game.turn,
        winner: this.game.winner,
        ready,
        online,
        names: [
          this.game.names?.[0] || "Ivory",
          this.game.names?.[1] || "Ember",
        ],
        moves: this.game.moves,
        board: isOver ? this.game.board : null,
        line: isOver ? this.game.line : null,
      };

      try {
        ws.send(JSON.stringify(payload));
      } catch {
        // Socket may be closing
      }
    }
  }
}
