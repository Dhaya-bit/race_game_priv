// Client-side game logic: driving, track, leaderboard
const socket = io();
const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");

const leaderboardEl = document.getElementById("leaderboard");
const statusEl = document.getElementById("status");
const nameInput = document.getElementById("nameInput");
const totalLapsEl = document.getElementById("totalLaps");

const WIDTH = canvas.width;
const HEIGHT = canvas.height;

const CENTER_X = WIDTH / 2;
const CENTER_Y = HEIGHT / 2;
const OUTER_R = 260;
const INNER_R = 120;
const MID_R = (OUTER_R + INNER_R) / 2;

const START_ANGLE = -Math.PI / 2; // top
const TOTAL_LAPS = 3;
totalLapsEl.textContent = TOTAL_LAPS;

let players = {};
let myId = null;
let myCar = null;
let keys = {};
let boostClicks = 0;

// input name
nameInput.addEventListener("change", () => {
  socket.emit("setName", nameInput.value || "");
});

// clicking for boost
document.addEventListener("mousedown", () => {
  boostClicks++;
});

// WASD / key handling
document.addEventListener("keydown", (e) => { keys[e.key.toLowerCase()] = true; });
document.addEventListener("keyup", (e) => { keys[e.key.toLowerCase()] = false; });

// connect
socket.on("connect", () => {
  myId = socket.id;
});

// get periodic updates
socket.on("updatePlayers", (data) => {
  players = data || {};
  if (myId && players[myId]) {
    myCar = players[myId];
    if (nameInput.value === "") nameInput.value = myCar.name || "";
  }
  updateLeaderboard();
});

// helper: clamp point inside annulus
function clampToTrack(x, y) {
  const dx = x - CENTER_X;
  const dy = y - CENTER_Y;
  const dist = Math.sqrt(dx*dx + dy*dy);
  if (dist > OUTER_R - 10) { // outside outer -> push in
    const factor = (OUTER_R - 10) / dist;
    return { x: CENTER_X + dx * factor, y: CENTER_Y + dy * factor };
  }
  if (dist < INNER_R + 10) { // inside inner hole -> push out
    const factor = (INNER_R + 10) / (dist || 0.0001);
    return { x: CENTER_X + dx * factor, y: CENTER_Y + dy * factor };
  }
  return { x, y };
}

// compute normalized angle in [0, 2PI)
function normAngle(a) {
  let v = a % (Math.PI * 2);
  if (v < 0) v += Math.PI * 2;
  return v;
}

// compute progress value for leaderboard (higher = further ahead)
function computeProgress(p) {
  // use laps * big + angle progress where START_ANGLE = 0 reference
  const ang = normAngle(Math.atan2(p.y - CENTER_Y, p.x - CENTER_X));
  // map so that start angle corresponds to 0
  const ref = normAngle(START_ANGLE);
  let relative = ang - ref;
  if (relative < 0) relative += Math.PI * 2;
  // progress increases as they move forward around the track
  return (p.laps || 0) * 100000 + Math.floor(relative * 1000);
}

// draw track (annulus)
function drawTrack() {
  // outer
  ctx.fillStyle = "#5a5a5a";
  ctx.beginPath();
  ctx.arc(CENTER_X, CENTER_Y, OUTER_R, 0, Math.PI * 2);
  ctx.fill();

  // inner (cut out)
  ctx.globalCompositeOperation = "destination-out";
  ctx.beginPath();
  ctx.arc(CENTER_X, CENTER_Y, INNER_R, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = "source-over";

  // lane stripes slightly
  ctx.strokeStyle = "#444";
  ctx.setLineDash([12, 8]);
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(CENTER_X, CENTER_Y, (OUTER_R + INNER_R) / 2, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);

  // start line
  const sx = CENTER_X + Math.cos(START_ANGLE) * (INNER_R - 8);
  const sy = CENTER_Y + Math.sin(START_ANGLE) * (INNER_R - 8);
  const ex = CENTER_X + Math.cos(START_ANGLE) * (OUTER_R + 8);
  const ey = CENTER_Y + Math.sin(START_ANGLE) * (OUTER_R + 8);
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(sx, sy);
  ctx.lineTo(ex, ey);
  ctx.stroke();
}

// draw a car rectangle rotated by angle
function drawCar(p, isMe) {
  const w = 36, h = 20;
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(p.angle);
  ctx.fillStyle = p.color || "#ff5555";
  ctx.fillRect(-w/2, -h/2, w, h);
  ctx.restore();

  // name and lap
  ctx.fillStyle = "#fff";
  ctx.font = "12px Arial";
  ctx.fillText(`${p.name || 'Player'}`, p.x - 18, p.y - 18);
  ctx.fillText(`Lap ${p.laps || 0}`, p.x - 18, p.y + 28);

  if (isMe && p.winner) {
    // big banner
    ctx.fillStyle = "gold";
    ctx.font = "36px Arial";
    ctx.fillText("🏆 WINNER!", WIDTH/2 - 120, HEIGHT/2);
  }
}

// update leaderboard DOM
function updateLeaderboard() {
  const arr = Object.values(players || []);
  arr.sort((a,b) => computeProgress(b) - computeProgress(a));
  leaderboardEl.innerHTML = "";
  arr.forEach((p, i) => {
    const entry = document.createElement("div");
    entry.className = "lb-entry";
    entry.innerHTML = `<div><span class="name" style="color:${p.color};">${i+1}. ${p.name || 'Player'}</span>
      <div class="meta">Lap ${p.laps || 0}</div></div>
      <div class="meta">${Math.max(0,Math.floor((computeProgress(p) % 100000)/1000))}%</div>`;
    leaderboardEl.appendChild(entry);
  });
  // show winner text if someone's winner
  const winner = arr.find(p => p.winner);
  statusEl.textContent = winner ? `${winner.name} finished the race!` : "";
}

// throttle sends to server
let lastSend = 0;
const SEND_INTERVAL = 50; // ms

function sendMyStateIfNeeded(state) {
  const now = Date.now();
  if (now - lastSend > SEND_INTERVAL) {
    socket.emit("move", state);
    lastSend = now;
  }
}

// main loop & physics
function gameLoop() {
  // if we have myCar locally, control it; else just render
  if (myCar) {
    // controls; rotation with A/D, forward/backwards with W/S, click adds boost
    const turnSpeed = 0.06; // radians per frame
    const accelBase = 0.12;
    const maxSpeed = 6.2;
    const boost = Math.min(boostClicks, 12) * 0.22; // boost from clicking
    if (keys["a"]) myCar.angle -= turnSpeed;
    if (keys["d"]) myCar.angle += turnSpeed;
    if (keys["w"]) myCar.speed += accelBase + boost;
    if (keys["s"]) myCar.speed -= 0.35;

    // natural friction
    myCar.speed *= 0.985;
    if (Math.abs(myCar.speed) < 0.01) myCar.speed = 0;

    // clamp speed
    if (myCar.speed > maxSpeed) myCar.speed = maxSpeed;
    if (myCar.speed < -2) myCar.speed = -2;

    // apply movement
    myCar.x += Math.cos(myCar.angle) * myCar.speed;
    myCar.y += Math.sin(myCar.angle) * myCar.speed;

    // clamp to track annulus
    const clamped = clampToTrack(myCar.x, myCar.y);
    myCar.x = clamped.x;
    myCar.y = clamped.y;

    // lap detection: detect crossing the start angle from previous angle to current angle in positive direction
    const prevAng = normAngle(myCar.lastAngle || myCar.angle);
    const currAng = normAngle(Math.atan2(myCar.y - CENTER_Y, myCar.x - CENTER_X));
    // we consider a crossing if we pass the start angle (ref) in the clockwise direction
    const ref = normAngle(START_ANGLE);
    // detect a wrap: if prev is > ref and curr <= ref, increment lap
    if (prevAng > ref + 0.01 && currAng <= ref + 0.01) {
      // ensure car is roughly in the forward lane (optional check)
      myCar.laps = (myCar.laps || 0) + 1;
      if (myCar.laps >= TOTAL_LAPS && !myCar.winner) {
        myCar.winner = true;
      }
    }
    myCar.lastAngle = currAng;

    // decay boost slowly
    if (boostClicks > 0) boostClicks -= 0.35;

    // send state to server periodically
    sendMyStateIfNeeded({
      x: myCar.x,
      y: myCar.y,
      angle: myCar.angle,
      speed: myCar.speed,
      laps: myCar.laps,
      winner: myCar.winner,
      name: nameInput.value || myCar.name,
      lastAngle: myCar.lastAngle
    });
  }

  // render
  ctx.clearRect(0,0,WIDTH,HEIGHT);
  // background
  ctx.fillStyle = "#2a2a2a";
  ctx.fillRect(0,0,WIDTH,HEIGHT);

  drawTrack();

  // draw all players
  for (const id in players) {
    const p = players[id];
    // ensure there are default values
    if (typeof p.angle !== 'number') p.angle = normAngle(Math.atan2(p.y - CENTER_Y, p.x - CENTER_X));
    drawCar(p, id === myId);
  }

  requestAnimationFrame(gameLoop);
}

// start loop
requestAnimationFrame(gameLoop);
