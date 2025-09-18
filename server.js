const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);

app.use(express.static("public"));

let players = {};

// Broadcast all players on a regular interval for smoothness
const BROADCAST_INTERVAL = 50; // ms
setInterval(() => {
  io.emit("updatePlayers", players);
}, BROADCAST_INTERVAL);

io.on("connection", (socket) => {
  console.log("Player connected:", socket.id);

  // initial state: placed slightly around the start angle
  const startAngle = -Math.PI / 2;
  const spawnIndex = Object.keys(players).length;
  const angleOffset = (spawnIndex * 0.25) % (Math.PI * 2);
  const startRadius = 190; // mid track radius
  const centerX = 400;
  const centerY = 300;

  const x = centerX + Math.cos(startAngle + angleOffset) * startRadius;
  const y = centerY + Math.sin(startAngle + angleOffset) * startRadius;

  players[socket.id] = {
    id: socket.id,
    name: `Player${spawnIndex + 1}`,
    x,
    y,
    angle: startAngle + angleOffset,
    speed: 0,
    color: "#" + Math.floor(Math.random() * 16777215).toString(16),
    laps: 0,
    winner: false,
    lastAngle: startAngle + angleOffset // track for lap detection
  };

  // send initial state
  io.emit("updatePlayers", players);

  socket.on("move", (data) => {
    if (players[socket.id]) {
      // only accept sanitized fields
      players[socket.id].x = data.x;
      players[socket.id].y = data.y;
      players[socket.id].angle = data.angle;
      players[socket.id].speed = data.speed;
      players[socket.id].laps = data.laps;
      players[socket.id].winner = data.winner;
      players[socket.id].name = data.name || players[socket.id].name;
      players[socket.id].lastAngle = data.lastAngle || players[socket.id].lastAngle;
    }
  });

  socket.on("setName", (n) => {
    if (players[socket.id]) players[socket.id].name = String(n).slice(0, 20);
    io.emit("updatePlayers", players);
  });

  socket.on("disconnect", () => {
    console.log("Player disconnected:", socket.id);
    delete players[socket.id];
    io.emit("updatePlayers", players);
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
