# Blindfold Connect 5

A 2-player remote **Blindfold Connect 5** (Gomoku) web app built for Cloudflare Workers + Durable Objects with zero frameworks and no build step.

## Rules

- **15×15 grid**: Columns `A–O`, rows `1–15`.
- **Players**: Player 1 is **Ivory**, Player 2 is **Ember**. Ivory moves first in game 1.
- **Blindfold play**: Neither player sees the board during play—only coordinates, last moves, and a collapsible move history.
- **Occupied cells**: Attempting to place a stone on an occupied coordinate rejects the move with feedback and vibration without passing the turn.
- **Win / Draw**: 5 or more in a row (horizontal, vertical, or either diagonal) wins and reveals the full board with the winning line highlighted. Filling all 225 cells ends in a draw and reveals the board.
- **Rematch**: "Play again" resets the board and swaps who moves first.

## Architecture

- `src/worker.js`: Routes `/ws/<CODE>` WebSocket upgrades to the `Room` Durable Object (`env.ROOM.idFromName(code)`) and serves `./public` via the `ASSETS` binding.
- `Room` Durable Object: Uses the WebSocket Hibernation API (`state.acceptWebSocket`, `webSocketMessage`, `webSocketClose`, `serializeAttachment` / `deserializeAttachment`) and persists authoritative game state in `state.storage`.
- `public/index.html`: Single-file mobile-first UI (inline CSS + JS) with `localStorage` UUID player tokens, `1.5s` auto-reconnect, `navigator.share` invite links (`/#CODE`), and dark/light `prefers-color-scheme` support.

## Local Development

```bash
npm install
npx wrangler dev
```

Open two browser sessions (for example, a normal window and an incognito window so each gets its own `localStorage` token) at `http://127.0.0.1:8787`.

## Deploy

```bash
npx wrangler deploy
```
