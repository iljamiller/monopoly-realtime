const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(express.static("public"));

app.get("/", (_req, res) => {
  res.redirect("/player.html");
});

// Хранилище состояния в памяти (MVP)
const players = new Map(); // playerId -> { id, name, money, trust, history:[], room }
const hosts = new Set();   // socket.id (для рассылки ведущим)

function nowISO() {
  return new Date().toISOString();
}

// Отправить полное состояние всем ведущим
function broadcastPlayersToHosts() {
  const list = Array.from(players.values()).map(p => ({
    id: p.id,
    name: p.name,
    money: p.money,
    trust: p.trust,
    history: p.history.slice(-10) // последних 10 записей — чтобы не раздувать
  }));
  io.to("hosts").emit("players:list", list);
}

// Отправить состояние конкретному игроку (в его комнату)
function sendPlayerState(playerId) {
  const p = players.get(playerId);
  if (!p) return;
  io.to(p.room).emit("player:state", {
    id: p.id,
    name: p.name,
    money: p.money,
    trust: p.trust,
    history: p.history
  });
}

io.on("connection", (socket) => {
  // Страница HOST
  socket.on("host:join", () => {
    hosts.add(socket.id);
    socket.join("hosts");
    // отправляем текущий список игроков
    broadcastPlayersToHosts();
  });

  // Подключение игрока
  // payload: { name: string }
  socket.on("player:join", (payload, ack) => {
    const name = (payload?.name || "").trim().slice(0, 50);
    if (!name) {
      ack?.({ ok: false, error: "Укажите имя" });
      return;
    }

    // Создаём сущность игрока
    const id = "p_" + Math.random().toString(36).slice(2, 10);
    const room = "player:" + id;
    socket.join(room);

    const player = {
      id,
      name,
      money: 1500,
      trust: 50,
      history: [{ ts: nowISO(), note: `Игрок подключился: ${name}. Стартовые ресурсы 1500 у.е., доверие 50.` }],
      room
    };

    players.set(id, player);

    // Ответ игроку
    ack?.({ ok: true, playerId: id });
    sendPlayerState(id);
    broadcastPlayersToHosts();

    // Привяжем к сокету, чтобы при дисконнекте знать, кого убирать (опционально)
    socket.data.playerId = id;
  });

  // Игрок запрашивает своё актуальное состояние по playerId (например, после перезагрузки вкладки)
  socket.on("player:bind", ({ playerId }, ack) => {
    const p = players.get(playerId);
    if (!p) {
      ack?.({ ok: false });
      return;
    }
    socket.join(p.room);
    sendPlayerState(playerId);
    ack?.({ ok: true });
  });

  // Ведущий меняет ресурсы
  // payload: { playerId, moneyDelta?: number, trustDelta?: number, note?: string }
  socket.on("host:adjust", (payload, ack) => {
    const { playerId } = payload || {};
    const p = players.get(playerId);
    if (!p) {
      ack?.({ ok: false, error: "Игрок не найден" });
      return;
    }
    const moneyDelta = Number(payload.moneyDelta || 0);
    const trustDelta = Number(payload.trustDelta || 0);
    const note = (payload.note || "").trim();

    if (moneyDelta) p.money = Math.max(0, p.money + moneyDelta);
    if (trustDelta) p.trust = Math.max(0, p.trust + trustDelta);

    const changeParts = [];
    if (moneyDelta) changeParts.push(`у.е. ${moneyDelta > 0 ? "+" : ""}${moneyDelta}`);
    if (trustDelta) changeParts.push(`доверие ${trustDelta > 0 ? "+" : ""}${trustDelta}`);
    const changeText = changeParts.join(", ") || "без изменений";

    p.history.push({
      ts: nowISO(),
      note: `Ведущий обновил: ${changeText}${note ? ` — ${note}` : ""}`
    });
    // ограничим историю до 100 записей
    if (p.history.length > 100) p.history = p.history.slice(-100);

    sendPlayerState(playerId);
    broadcastPlayersToHosts();
    ack?.({ ok: true });
  });

  // Ведущий может удалить игрока (например, вышел из игры)
  socket.on("host:removePlayer", ({ playerId }, ack) => {
    const p = players.get(playerId);
    if (!p) {
      ack?.({ ok: false, error: "Игрок не найден" });
      return;
    }
    io.in(p.room).socketsLeave(p.room);
    players.delete(playerId);
    broadcastPlayersToHosts();
    ack?.({ ok: true });
  });

  socket.on("disconnect", () => {
    // Если это был хост — просто убираем из набора
    if (hosts.has(socket.id)) {
      hosts.delete(socket.id);
    }
    // Если это был единственный сокет игрока — игрок остаётся в памяти (чтобы можно было вернуться/переподключиться)
    // Удалять игрока автоматически не будем в MVP.
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
