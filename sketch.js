let video;
let bodyPose;
let poses = [];
let camPull = null; // tiny off-screen buffer used to keep camera frames fresh

let shrimpImgs = [];

let smoothRatio = 0;
let smoothTilt = 0;
let smoothWidth = 0;

let baseRatio = null;
let baseTilt = null;
let baseWidth = null;

let calibrating = false;
let calibStart = 0;
let ratioSamples = [];
let tiltSamples = [];
let widthSamples = [];
const CALIB_MS = 3000; // 3s countdown so the user can sit up straight

// posture thresholds (hysteresis). Lower ratio = head dropped toward shoulders.
const SLUMP_ENTER = 0.92; // slouch if ratio falls to 92% of baseline (sensitive)
const SLUMP_EXIT = 0.96;
// leaning toward the screen makes shoulders wider in frame
const LEAN_ENTER = 1.08;  // slouch if shoulders grow to 108% of baseline
const LEAN_EXIT = 1.04;

// timing
const HOLD_MS = 10000;        // fully cooked after 10s slouching
const DEATH_MS = 30000;       // fully dead after 30s slouching
const REVIVE_HOLD_MS = 5000; // must sit up straight 5s to revive

let badStart = null;

// debounced posture state (prevents frame-to-frame flicker at the threshold)
let badState = false;      // committed "is the user slouching" state
let pendingBad = false;    // what the raw signal currently wants
let pendingSince = 0;      // when the raw signal last changed
const BAD_DEBOUNCE_MS = 300; // slouch must persist this long before he cooks
const GOOD_DEBOUNCE_MS = 50; // sitting up recovers essentially instantly
let cookMs = 0;            // accumulated ms of genuine slouching

const CONF = 0.25;
const MIN_CONF = 0.2; // min average keypoint confidence to trust the posture read
const GRACE_FRAMES = 15;
let lostFrames = 0;
let unseenMs = 0;              // how long the user has been out of view
const PAUSE_AFTER_MS = 10000;  // pause the session timer after 10s away

// shrimp state
let cookedness = 0;   // 0 straight/grey -> 1 curled/pink
let gone = 0;         // 0 fine -> 1 dead
let isDead = false;
let reviving = 0;
let cookedCounted = false;
let recovery = 0;     // banked good-posture time while dead

// stats
let sessionStart = null;
let aliveStart = null;
let cookedCount = 0;

// desktop-widget state
let hovering = false;   // show stats only while the mouse is over the shrimp
let settling = false;   // true when recovering: stop shaking, then morph calmly
let sessionActive = false; // whether a tracking session is running
let frozenSession = 0;  // session time snapshot when a session ends
let frozenAlive = 0;    // alive time snapshot when a session ends
let longestAlive = 0;   // best alive streak during the current session
let ipc = null;         // electron ipcRenderer (set in setup)
let dragging = false;
// layout: panels stack on the left, the shrimp lives on the right.
// the shrimp is anchored a fixed distance from the top-right corner, so it
// stays put when the window grows/shrinks on hover.
const RIGHT_MARGIN = 130;
const TOP_Y = 120;
const SHRIMP_BOX = 170;
let SHRIMP_CX = 350; // recomputed each frame from the current width
let SHRIMP_CY = TOP_Y;

// --- palette (exact) ---
const FONT = "Fredoka";
const COL_ACCENT = "#FF6B4A"; // warm coral
const COL_WARN = "#E8452A";   // deepened coral for cooking/warning
const COL_WASH = "#EAF4F4";   // sea-glass underwater wash
const COL_PAPER = "#FFF8F0";  // warm cream paper
const COL_INK = "#3D2B24";    // soft dark brown text
const COL_BORDER = "#F0DCC9"; // slightly-warm 1px panel border

// --- ambient motion state ---
let hoverAnim = 0;   // eases 0->1 for panel fade/slide-in
let driftPhase = 0;  // slow underwater sway
let bubbles = [];    // rising bubbles
let blinkTimer = 0;  // occasional slow blink

// posture runs on a timer (not the render loop) so it keeps working when the
// window is unfocused / in the background, where the render loop gets throttled
let renderStatus = "";   // latest coaching message, set by updatePosture()
let detecting = false;   // a detection is in flight
let lastUpdate = 0;      // for computing real elapsed time between ticks
let useDetectStart = false;
let modelReady = false;  // ml5 model finished loading

// diagnostic values (shown on hover while DEBUG is true)
const DEBUG = false;
let dbgConf = 0, dbgRatio = 0, dbgLine = 0, dbgTilt = 0, dbgTiltLine = 0;
// respect the OS "reduce motion" accessibility setting
let reducedMotion =
  typeof window !== "undefined" &&
  window.matchMedia &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

async function setup() {
  let cnv = createCanvas(windowWidth, windowHeight);
  video = createCapture(VIDEO);
  video.size(640, 480);
  video.hide();
  camPull = createGraphics(32, 24); // off-screen; drawing the video keeps it fresh
  loadSounds();
  textFont(FONT);
  for (let i = 0; i < 5; i++) bubbles.push(newBubble(true));

  // right-click / two-finger tap the shrimp to (re)calibrate
  const onContext = (e) => {
    e.preventDefault();
    startCalibration();
    return false;
  };
  cnv.elt.addEventListener("contextmenu", onContext);
  window.addEventListener("contextmenu", onContext);

  // hover expands the window (revealing the panels); leaving shrinks it back
  document.body.addEventListener("mouseenter", () => {
    hovering = true;
    if (ipc) ipc.send("set-hover", true);
  });
  document.body.addEventListener("mouseleave", () => {
    hovering = false;
    if (ipc) ipc.send("set-hover", false);
  });

  // left-click-drag the shrimp to move the whole widget around the screen
  cnv.elt.addEventListener("mousedown", (e) => {
    if (e.button === 0 && ipc) {
      dragging = true;
      ipc.send("drag-start");
    }
  });
  window.addEventListener("mousemove", () => {
    if (dragging && ipc) ipc.send("drag-move");
  });
  window.addEventListener("mouseup", () => {
    if (dragging && ipc) {
      dragging = false;
      ipc.send("drag-end");
    }
  });

  // let the menu bar "Recalibrate" item trigger calibration too
  try {
    const { ipcRenderer } = require("electron");
    ipc = ipcRenderer;
    ipc.on("recalibrate", () => startCalibration());
    // the main process drives detection so it keeps running in the background
    ipc.on("tick", () => tick());
    ipc.on("set-sound", (e, on) => (soundOn = !!on));
  } catch (e) {}

  // expose session controls so the HTML buttons can call them
  window.startSession = startSession;
  window.endSession = endSession;

  // load shrimp frames
  shrimpImgs[0] = await loadImage("shrimp1.png"); // grey / straight
  shrimpImgs[1] = await loadImage("shrimp2.png"); // transition
  shrimpImgs[2] = await loadImage("shrimp3.png"); // cooked / curled

  // ml5 1.x: mark ready once the model loads. Detection is driven by ticks
  // sent from the MAIN process (Node timers aren't throttled in the
  // background), not by a renderer timer or ml5's animation-frame loop.
  bodyPose = ml5.bodyPose("MoveNet", () => {
    modelReady = true;
  });
}

// one step: run a pose detection, then update the cook/recover logic
function tick() {
  let now = millis();
  let dt = lastUpdate === 0 ? 70 : now - lastUpdate;
  lastUpdate = now;

  if (modelReady && !useDetectStart && bodyPose && video && !detecting) {
    detecting = true;
    try {
      const ret = bodyPose.detect(video, (results) => {
        poses = results || [];
        detecting = false;
      });
      if (ret && typeof ret.then === "function") {
        ret
          .then((r) => {
            if (r) poses = r;
            detecting = false;
          })
          .catch(() => (detecting = false));
      }
    } catch (e) {
      // older ml5: no single-shot detect(); fall back to continuous detectStart
      detecting = false;
      useDetectStart = true;
      try {
        bodyPose.detectStart(video, gotPoses);
      } catch (e2) {}
    }
  }

  updatePosture(dt);
}

function gotPoses(results) {
  poses = results;
}

// keep the canvas matching the window as it grows/shrinks on hover
function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}

function startCalibration() {
  calibrating = true;
  calibStart = millis();
  ratioSamples = [];
  tiltSamples = [];
  widthSamples = [];
  cookMs = 0;
  badState = false;
  pendingBad = false;
  pendingSince = millis();
  unseenMs = 0;
}

// ---------- sound (custom mp3 clips) ----------
let soundOn = true;
let sounds = {};
let soundPrevIdx = 0; // last cook stage we played a sound for

function loadSounds() {
  const names = ["sparkle", "sizzle", "gasp", "dead"];
  for (const n of names) {
    const a = new Audio("sounds/" + n + ".mp3");
    a.preload = "auto";
    sounds[n] = a;
  }
}
function playSound(name) {
  if (!soundOn) return;
  const a = sounds[name];
  if (!a) return;
  try {
    a.currentTime = 0;
    const p = a.play();
    if (p && p.catch) p.catch(() => {});
  } catch (e) {}
}

// Begin a fresh tracking session and immediately (re)calibrate.
function startSession() {
  playSound("sparkle"); // the button click is a user gesture -> unlocks audio
  soundPrevIdx = 0;
  sessionActive = true;
  sessionStart = null; // both timers start together when calibration finishes
  aliveStart = null;
  cookedCount = 0;
  cookedness = 0;
  gone = 0;
  isDead = false;
  reviving = 0;
  longestAlive = 0;
  baseRatio = null; // force a fresh calibration
  baseTilt = null;
  baseWidth = null;
  startCalibration();
}

// current session totals (for the menu-bar history / quit recording)
let lastLiveSend = 0;
function currentSummary() {
  let dur = sessionStart === null ? 0 : millis() - sessionStart;
  let curStreak = isDead || aliveStart === null ? 0 : millis() - aliveStart;
  return {
    durationMs: dur,
    cookedCount: cookedCount,
    bestAliveMs: max(longestAlive, curStreak),
  };
}

// Stop the session; freeze the stats where they landed.
function endSession() {
  if (sessionActive) {
    frozenSession = sessionStart === null ? 0 : millis() - sessionStart;
    let curStreak = isDead || aliveStart === null ? 0 : millis() - aliveStart;
    frozenAlive = curStreak;
    let best = max(longestAlive, curStreak);
    // log the finished session to the menu bar history
    if (ipc) {
      ipc.send("session-ended", {
        durationMs: frozenSession,
        cookedCount: cookedCount,
        bestAliveMs: best,
      });
      ipc.send("session-cleared");
    }
  }
  sessionActive = false;
  calibrating = false;
}

// Show the right button for the current state (Start when idle, End on hover).
function updateButtons() {
  const s = document.getElementById("startBtn");
  const e = document.getElementById("endBtn");
  if (!s || !e) return;
  // buttons only while expanded (hovered)
  s.style.display = hovering && !sessionActive ? "block" : "none";
  e.style.display = hovering && sessionActive ? "block" : "none";
}

function keyPressed() {
  if (key === "c" || key === "C") {
    startCalibration();
  }
}

// two-finger tap also registers as the RIGHT mouse button
function mousePressed() {
  if (mouseButton === RIGHT) startCalibration();
}

// -------- render loop (animation-frame; may throttle in background) --------
function draw() {
  clear(); // transparent background so only the shrimp shows

  // Pull a frame from the camera every render frame (even when not hovering).
  // A hidden video element stops advancing its frame unless something reads it,
  // which is why detection used to freeze until you hovered the preview.
  if (video && camPull) camPull.image(video, 0, 0, 32, 24);

  // anchor the shrimp near the top-right so it stays put across resizes
  SHRIMP_CX = width - RIGHT_MARGIN;
  SHRIMP_CY = TOP_Y;

  // advance ambient motion (frozen when the user prefers reduced motion)
  driftPhase += reducedMotion ? 0 : 0.02;
  let hoverTarget = hovering ? 1 : 0;
  hoverAnim += (hoverTarget - hoverAnim) * (reducedMotion ? 1 : 0.18);

  updateButtons();

  drawShrimp(cookedness);

  // panels (stats/webcam/tag) are hover-only...
  if (hovering || hoverAnim > 0.02) {
    drawStats();
    drawDebug();
    drawPostureTag();
    if (DEBUG) drawDebugReadout();
  }
  // ...but the coaching prompts always show, during an active session
  if (sessionActive) drawStatus(renderStatus);
}

// -------- posture logic (timer; keeps running in the background) --------
function updatePosture(dt) {
  settling = true; // default calm; the cooking branch turns shaking on

  // no session running: calm shrimp, no posture reactions
  if (!sessionActive) {
    cookedness = 0;
    gone = 0;
    isDead = false;
    renderStatus = "";
    return;
  }

  // periodic snapshot so the session is recorded even if the app quits
  if (ipc && millis() - lastLiveSend > 1000) {
    lastLiveSend = millis();
    ipc.send("session-active", currentSummary());
  }

  let pose = poses.length > 0 ? poses[0] : null;
  let nose = pose ? getPoint(pose, "nose") : null;
  let ls = pose ? getPoint(pose, "left_shoulder") : null;
  let rs = pose ? getPoint(pose, "right_shoulder") : null;
  let haveData = nose && ls && rs;

  // pause the session + alive clocks once the user's been away for 10s+
  let seenNow = haveData && postureConfidence(pose) >= MIN_CONF;
  if (seenNow) {
    unseenMs = 0;
  } else {
    unseenMs += dt;
    if (unseenMs >= PAUSE_AFTER_MS) {
      // push the start times forward so elapsed time stops advancing
      if (sessionStart !== null) sessionStart += dt;
      if (aliveStart !== null) aliveStart += dt;
    }
  }

  // brief dropout grace
  if (!haveData) {
    lostFrames++;
    if (lostFrames > GRACE_FRAMES) {
      handleUnseen();
      renderStatus = isDead ? "still a ghost. still your fault." : "where'd you go?";
      return;
    }
    renderStatus = isDead ? "still a ghost…" : "one sec…";
    return;
  }
  lostFrames = 0;

  // signals
  let shoulderY = (ls.y + rs.y) / 2;
  let gap = shoulderY - nose.y;
  let shoulderWidth = dist(ls.x, ls.y, rs.x, rs.y);
  let ratio = gap / shoulderWidth;
  let tilt = abs(ls.y - rs.y) / shoulderWidth;

  if (smoothRatio === 0) smoothRatio = ratio;
  if (smoothTilt === 0) smoothTilt = tilt;
  if (smoothWidth === 0) smoothWidth = shoulderWidth;
  // time-based smoothing so it responds the same regardless of tick spacing
  let sa = constrain(dt / 180, 0, 1);
  smoothRatio += (ratio - smoothRatio) * sa;
  smoothTilt += (tilt - smoothTilt) * sa;
  smoothWidth += (shoulderWidth - smoothWidth) * sa;

  // calibration
  if (calibrating) {
    ratioSamples.push(smoothRatio);
    tiltSamples.push(smoothTilt);
    widthSamples.push(smoothWidth);
    if (millis() - calibStart >= CALIB_MS) {
      baseRatio = average(ratioSamples);
      baseTilt = average(tiltSamples);
      baseWidth = average(widthSamples);
      calibrating = false;
      if (sessionStart === null) sessionStart = millis();
      aliveStart = millis();
      isDead = false;
      cookedness = 0;
      gone = 0;
      cookMs = 0;
      badState = false;
      pendingBad = false;
      pendingSince = millis();
    }
    renderStatus = ""; // drawStatus renders its own calibration countdown
    return;
  }

  if (baseRatio === null) {
    renderStatus = "sit up tall & poke start";
    return;
  }

  // can't see you clearly (turned / hand on head)
  let conf = postureConfidence(pose);
  dbgConf = conf;
  if (conf < MIN_CONF) {
    handleUnseen();
    renderStatus = isDead ? "still gone…" : "hmm, i lost you";
    return;
  }

  // posture signals (value hysteresis: harder to enter "bad" than to leave it)
  let slumpLine = baseRatio * (!badState ? SLUMP_ENTER : SLUMP_EXIT);
  let slumping = smoothRatio < slumpLine;
  let leanLine = baseWidth * (!badState ? LEAN_ENTER : LEAN_EXIT);
  let leaningIn = smoothWidth > leanLine;
  let tiltLine = baseTilt + (!badState ? 0.12 : 0.06);
  let tilting = smoothTilt > tiltLine;

  let rawBad = slumping || leaningIn || tilting;

  dbgRatio = smoothRatio;
  dbgLine = slumpLine;
  dbgTilt = smoothWidth;
  dbgTiltLine = leanLine;

  // temporal debounce so a borderline posture can't flicker the state
  if (rawBad !== pendingBad) {
    pendingBad = rawBad;
    pendingSince = millis();
  }
  let debounceNeeded = pendingBad ? BAD_DEBOUNCE_MS : GOOD_DEBOUNCE_MS;
  if (millis() - pendingSince >= debounceNeeded) {
    badState = pendingBad;
  }

  // fast recovery: if the RAW posture is clearly upright (not borderline),
  // snap out of "bad" instantly instead of waiting for the smoothed value —
  // so sitting tall flips a cooked shrimp back to shrimp 1 with no delay.
  if (badState) {
    let clearlyGood =
      ratio > baseRatio * 0.98 &&
      shoulderWidth < baseWidth * 1.03 &&
      tilt < baseTilt + 0.05;
    if (clearlyGood) {
      badState = false;
      pendingBad = false;
      pendingSince = millis();
      smoothRatio = ratio; // sync smoothed values so it doesn't re-cook next tick
      smoothWidth = shoulderWidth;
      smoothTilt = tilt;
    }
  }

  let status = "";

  if (isDead) {
    cookedness = 1;
    gone = 1;
    if (!badState) {
      recovery += dt;
      let left = ceil((REVIVE_HOLD_MS - recovery) / 1000);
      if (recovery >= REVIVE_HOLD_MS) {
        isDead = false;
        reviving = 18;
        recovery = 0;
        cookMs = 0;
        cookedCounted = false; // so the recovery branch doesn't replay sparkle
        aliveStart = millis();
        status = "oh—i'm alive!";
        playSound("sparkle"); // revived from the ghost
      } else {
        status = "keep sitting tall… back in " + left;
      }
    } else {
      recovery = 0;
      status = "sit tall to revive me";
    }
  } else if (badState) {
    settling = false; // actively getting cooked -> allow the fear tremble
    cookMs += dt; // build up only while genuinely slouching

    cookedness = constrain(cookMs / HOLD_MS, 0, 1);
    gone = constrain((cookMs - HOLD_MS) / (DEATH_MS - HOLD_MS), 0, 1);

    if (cookedness >= 1 && !cookedCounted) {
      cookedCount++;
      cookedCounted = true;
      longestAlive = max(longestAlive, millis() - aliveStart); // bank the streak
      aliveStart = millis(); // getting cooked breaks the streak -> reset alive
      playSound("dead"); // fully cooked
    }

    if (gone >= 1) {
      isDead = true;
      recovery = 0;
    }

    if (cookedness < 1) status = slumping ? "hey—sit up?" : "straighten out for me?";
    else status = "welp. cooked.";
  } else {
    // good posture: snap straight back to shrimp 1 (no morph through shrimp 2)
    if (cookedCounted) playSound("sparkle"); // came back to life after cooking
    cookMs = 0;
    cookedCounted = false;
    cookedness = 0;
    gone = 0;
    if (reviving > 0) reviving--;
    status = reviving > 0 ? "oh—i'm alive!" : "";
  }

  // sound cues as he cooks UP through the frames (not on the way back down)
  let idxNow = cookedness < 0.33 ? 0 : cookedness < 0.72 ? 1 : 2;
  if (idxNow > soundPrevIdx) {
    if (idxNow === 1) playSound("sizzle"); // turned into shrimp 2
    else if (idxNow === 2) playSound("gasp"); // turned into shrimp 3
  }
  soundPrevIdx = idxNow;

  renderStatus = status;
}

function handleUnseen() {
  // can't see the user clearly: freeze the current state (don't decay it,
  // which would make the shrimp flicker), and restart the debounce timer.
  pendingBad = badState;
  pendingSince = millis();
}

// ---------- drawing ----------

// current posture in the shrimp's own voice + an indicator colour
// (colour is a redundant cue only — the words carry the meaning too)
function postureStatus() {
  if (!sessionActive) return { label: "ready when you are", col: color(150, 140, 132) };
  if (poses.length === 0) return { label: "i can't see you", col: color(150, 140, 132) };
  if (!badState) return { label: "comfy. thanks!", col: color(90, 190, 140) };
  if (cookedness < 1) return { label: "i'm getting toasty", col: color(255, 107, 74) };
  return { label: "you cooked me", col: color(232, 69, 42) };
}

// webcam "porthole" — a cream-framed rounded window, hover-only (top-left)
function drawDebug() {
  let a = reducedMotion ? 1 : hoverAnim;
  if (a < 0.02) return;
  let slide = reducedMotion ? 0 : (1 - a) * 10;
  let w = 104, h = 78, x = 14, y = 12 + slide, r = 16;

  push();
  // cream paper frame with soft shadow
  rectMode(CORNER);
  drawingContext.shadowColor = "rgba(61,43,36," + (0.16 * a).toFixed(3) + ")";
  drawingContext.shadowBlur = 18;
  drawingContext.shadowOffsetY = 6;
  noStroke();
  fill(255, 248, 240, 236 * a);
  rect(x - 5, y - 5, w + 10, h + 10, r + 5);
  drawingContext.shadowBlur = 0;
  drawingContext.shadowOffsetY = 0;

  // clip the mirrored video into the rounded window
  drawingContext.save();
  drawingContext.beginPath();
  drawingContext.roundRect(x, y, w, h, r);
  drawingContext.clip();
  push();
  translate(x + w, y);
  scale(-1, 1);
  tint(255, 255 * a);
  if (video) image(video, 0, 0, w, h);
  noTint();
  pop();
  drawingContext.restore();
  pop();
}

// temporary numeric diagnostic so we can see why states do/don't change
function drawDebugReadout() {
  let lines = [
    "session " + (sessionActive ? "ON" : "off") + "  calib " + (baseRatio !== null ? "yes" : "NO"),
    "conf " + nf(dbgConf, 1, 2) + "  (need >" + nf(MIN_CONF, 1, 2) + ")",
    "head  " + nf(dbgRatio, 1, 2) + " < " + nf(dbgLine, 1, 2) + " ? slouch",
    "lean  " + nf(dbgTilt, 1, 0) + " > " + nf(dbgTiltLine, 1, 0) + " ? slouch",
    "badState " + badState + "  cooked " + nf(cookedness, 1, 2),
  ];
  textFont("monospace");
  textSize(10);
  textStyle(NORMAL);
  textAlign(LEFT, TOP);
  let bx = 8, by = 208, bw = 190, bh = lines.length * 13 + 10;
  noStroke();
  fill(0, 210);
  rect(bx, by, bw, bh, 8);
  fill(180, 240, 255);
  for (let i = 0; i < lines.length; i++) {
    text(lines[i], bx + 8, by + 6 + i * 13);
  }
}

// the shrimp's voice on a little cream tag, below the porthole (hand-tilted)
function drawPostureTag() {
  let a = reducedMotion ? 1 : hoverAnim;
  if (a < 0.02) return;
  let slide = reducedMotion ? 0 : (1 - a) * 12;
  let s = postureStatus();

  setFont(14, 400);
  let dotR = 9, padL = 13, gap = 9, padR = 16;
  let textW = tw(s.label);
  let w = padL + dotR + gap + textW + padR, h = 30, r = 15;
  let x = 14, y = 102 + slide;

  push();
  // slight hand-placed tilt
  translate(x + w / 2, y + h / 2);
  rotate(radians(-2));
  translate(-(x + w / 2), -(y + h / 2));

  drawPaper(x, y, w, h, r, a);

  noStroke();
  fill(red(s.col), green(s.col), blue(s.col), 255 * a);
  circle(x + padL + dotR / 2, y + h / 2, dotR);

  fill(61, 43, 36, 255 * a);
  setFont(14, 400);
  inkText(s.label, x + padL + dotR + gap, y + h / 2, "left", "middle");
  pop();
}

// ---------- craft helpers (Fredoka text + paper panels + ambient) ----------

// precise font weights on the canvas (p5's textStyle can't pick 300/500/600)
function setFont(size, weight) {
  drawingContext.font = weight + ' ' + size + 'px "Fredoka", sans-serif';
}
function tw(s) {
  return drawingContext.measureText(s).width;
}
function inkText(s, x, y, align, baseline) {
  drawingContext.textAlign = align || "left";
  drawingContext.textBaseline = baseline || "middle";
  drawingContext.fillText(s, x, y);
}

// a warm-cream paper tag: soft shadow, translucent fill, 1px warm border
function drawPaper(x, y, w, h, r, a) {
  push();
  rectMode(CORNER);
  drawingContext.shadowColor = "rgba(61,43,36," + (0.16 * a).toFixed(3) + ")";
  drawingContext.shadowBlur = 20;
  drawingContext.shadowOffsetY = 7;
  noStroke();
  fill(255, 248, 240, 216 * a); // #FFF8F0 ~85%
  rect(x, y, w, h, r);
  drawingContext.shadowBlur = 0;
  drawingContext.shadowOffsetY = 0;
  noFill();
  stroke(240, 220, 201, 210 * a); // #F0DCC9 warm border
  strokeWeight(1);
  rect(x, y, w, h, r);
  pop();
}

function newBubble(seed) {
  return {
    x: SHRIMP_CX + random(-70, 70),
    y: seed ? random(SHRIMP_CY - 70, SHRIMP_CY + 110) : SHRIMP_CY + random(90, 130),
    r: random(2, 6),
    spd: random(0.25, 0.8),
    wob: random(TWO_PI),
  };
}

// soft sea-glass glow behind him — stronger when calm, so he reads as underwater
function drawWash(calm) {
  let cx = SHRIMP_CX, cy = SHRIMP_CY + 4, R = 132;
  let a = 0.05 + 0.16 * calm; // very subtle
  let g = drawingContext.createRadialGradient(cx, cy, 6, cx, cy, R);
  g.addColorStop(0, "rgba(234,244,244," + a.toFixed(3) + ")");
  g.addColorStop(0.6, "rgba(234,244,244," + (a * 0.4).toFixed(3) + ")");
  g.addColorStop(1, "rgba(234,244,244,0)");
  push();
  drawingContext.fillStyle = g;
  drawingContext.beginPath();
  drawingContext.arc(cx, cy, R, 0, Math.PI * 2);
  drawingContext.fill();
  pop();
}

function updateBubbles() {
  for (let b of bubbles) {
    b.y -= b.spd;
    b.x += sin(frameCount * 0.05 + b.wob) * 0.3;
    if (b.y < SHRIMP_CY - 95) Object.assign(b, newBubble(false));
  }
  if (random() < 0.015 && bubbles.length < 9) bubbles.push(newBubble(false));
}

function drawBubbles() {
  noStroke();
  for (let b of bubbles) {
    fill(234, 244, 244, 120);
    circle(b.x, b.y, b.r * 2);
    fill(255, 255, 255, 80);
    circle(b.x - b.r * 0.3, b.y - b.r * 0.3, b.r * 0.8);
  }
}

function drawAmbient(c) {
  // bubbles drift up behind him; the underwater glow now hugs the shrimp
  // itself (drawn in drawShrimp) so it never gets clipped into a hard box
  if (!reducedMotion) {
    updateBubbles();
    drawBubbles();
  }
}

function drawShrimp(c) {
  drawAmbient(c); // sea-glass wash + rising bubbles, behind him

  push();
  translate(SHRIMP_CX, SHRIMP_CY);

  // gentle underwater drift + slow bob when calm & alive
  if (!reducedMotion && !isDead) {
    translate(sin(driftPhase * 0.7) * 6, 0);
    if (c < 0.1) translate(0, sin(millis() / 600) * 4);
  }

  // fear tremble grows as he cooks (but not while settling back down)
  if (!reducedMotion && c > 0.15 && !isDead && !settling) {
    let shake = c * c * 6;
    translate(random(-shake, shake), random(-shake, shake));
  }

  // slow breathing + an occasional slow blink (calm & alive only)
  if (!reducedMotion && !isDead && c < 0.1) {
    let breath = 1 + sin(millis() / 900) * 0.02;
    let bt = millis() % 5200;
    let blink = bt < 150 ? 1 - 0.12 * sin((bt / 150) * PI) : 1;
    scale(breath, breath * blink);
  }

  // revival pop
  if (reviving > 0) {
    let p = 1 + sin((reviving / 18) * PI) * 0.18;
    scale(p);
  }

  imageMode(CENTER);

  // HARD SWAP: pick one frame based on cookedness, no fade (unchanged logic)
  let idx;
  if (c < 0.33) idx = 0;
  else if (c < 0.72) idx = 1;
  else idx = 2;

  if (shrimpImgs[idx]) {
    // soft sea-glass glow that hugs his shape (fades naturally, never crops)
    let calm = 1 - constrain(c, 0, 1);
    drawingContext.save();
    drawingContext.shadowColor = "rgba(234,244,244," + (0.55 * calm).toFixed(3) + ")";
    drawingContext.shadowBlur = 28;
    drawFit(shrimpImgs[idx], SHRIMP_BOX);
    drawingContext.restore();
  }

  // dead-eye X — only once he's fully cooked (the logged "cooked" state)
  if (c >= 1 && shrimpImgs[2]) {
    let img = shrimpImgs[2];
    let s = SHRIMP_BOX / Math.max(img.width, img.height);
    let ex = img.width * s * (0.406 - 0.5); // eye at 40.6% across
    let ey = img.height * s * (0.371 - 0.5); // eye at 37.1% down
    let r = 8;
    stroke(50, 33, 27);
    strokeWeight(3);
    strokeCap(ROUND);
    line(ex - r, ey - r, ex + r, ey + r);
    line(ex - r, ey + r, ex + r, ey - r);
    noStroke();
  }

  // sweat drops as he gets scared
  if (c > 0.5 && !isDead) {
    let n = floor(map(c, 0.5, 1, 1, 3));
    fill(120, 180, 255, map(c, 0.5, 1, 100, 220));
    noStroke();
    for (let i = 0; i < n; i++) {
      let dx = -70 + i * 22 + random(-2, 2);
      let dy = -70 + random(-2, 2);
      ellipse(dx, dy, 7, 11);
    }
  }

  // ghost when dead
  if (gone > 0.05) {
    let rise = gone * 55;
    fill(255, 255, 255, gone * 160);
    noStroke();
    textSize(26);
    textAlign(CENTER, CENTER);
    text("👻", 0, -110 - rise);
  }

  pop();
  imageMode(CORNER); // reset so webcam preview draws right
}

// draw an image centered, scaled to fit inside `box` while keeping aspect ratio
function drawFit(img, box) {
  let iw = img.width || box;
  let ih = img.height || box;
  let s = box / Math.max(iw, ih);
  image(img, 0, 0, iw * s, ih * s);
}

function drawStats() {
  let a = reducedMotion ? 1 : hoverAnim;
  if (a < 0.02) return;
  let slide = reducedMotion ? 0 : (1 - a) * 12;
  let x = 12, y = 140 + slide, w = 186, h = 104, r = 20;

  let sess, alive;
  if (sessionActive) {
    if (sessionStart === null) {
      // during the calibration countdown, before tracking has started
      sess = "0:00";
      alive = "0:00";
    } else {
      sess = fmt(millis() - sessionStart);
      alive = isDead ? "0:00" : fmt(millis() - aliveStart);
    }
  } else {
    sess = sessionStart === null ? "--:--" : fmt(frozenSession);
    alive = fmt(frozenAlive);
  }

  push();
  // slight hand-placed tilt (opposite lean from the posture tag)
  translate(x + w / 2, y + h / 2);
  rotate(radians(1.5));
  translate(-(x + w / 2), -(y + h / 2));

  drawPaper(x, y, w, h, r, a);

  let lx = x + 18;
  let vx = x + w - 18;
  let rows = [y + 28, y + 55, y + 82];

  // labels (brown, medium 500)
  fill(61, 43, 36, 255 * a);
  setFont(15, 500);
  inkText("session", lx, rows[0], "left", "middle");
  inkText("alive", lx, rows[1], "left", "middle");
  inkText("cooked", lx, rows[2], "left", "middle");

  // values (brown, light 400)
  setFont(17, 400);
  fill(61, 43, 36, 255 * a);
  inkText(sess, vx, rows[0], "right", "middle");
  inkText(cookedCount + "×", vx, rows[2], "right", "middle");

  // alive streak in a coral accent chip — brown text on #FF6B4A ≈ 4.75:1 (AA).
  // the number is right-aligned to vx so it lines up with the other values.
  setFont(16, 500);
  let numW = tw(alive);
  let padX = 11, chH = 26;
  let chW = numW + padX * 2;
  let chX = vx - numW - padX;
  let chY = rows[1] - chH / 2;
  noStroke();
  rectMode(CORNER);
  fill(255, 107, 74, 236 * a);
  rect(chX, chY, chW, chH, 13);
  fill(61, 43, 36, 255 * a);
  setFont(16, 500);
  inkText(alive, vx, rows[1], "right", "middle");
  pop();
}

function drawStatus(msg) {
  // status sits just under the shrimp, above the button row
  let statusY = SHRIMP_CY + 95;

  // during calibration, count down from 3 so the user can sit up straight
  if (calibrating) {
    let elapsed = millis() - calibStart;
    let secs = max(1, ceil((CALIB_MS - elapsed) / 1000));
    drawStatusPill("sit up tall for me… " + secs, statusY - 10, color(90, 160, 220), SHRIMP_CX);
    // coral progress bar on a faint brown track
    let p = constrain(elapsed / CALIB_MS, 0, 1);
    let bw = 150, bh = 7, bx = SHRIMP_CX - bw / 2, by = statusY + 14;
    noStroke();
    rectMode(CORNER);
    fill(61, 43, 36, 45);
    rect(bx, by, bw, bh, 4);
    fill(255, 107, 74);
    rect(bx, by, bw * p, bh, 4);
    return;
  }

  // main status message in a cream pill (nothing shown when he's calm)
  if (msg && msg.length > 0) {
    let dot;
    if (isDead) dot = color(232, 69, 42);
    else if (cookedness > 0.05)
      dot = lerpColor(color(255, 107, 74), color(232, 69, 42), constrain(cookedness, 0, 1));
    else dot = color(90, 190, 140);
    drawStatusPill(msg, statusY, dot, SHRIMP_CX);
  }
}

// cream paper pill with a state dot + soft-brown text (state shown by dot AND words)
function drawStatusPill(msg, y, dotCol, cx) {
  if (cx === undefined) cx = width / 2;
  setFont(16, 400);
  let dotR = 10, padL = 16, gap = 10, padR = 20;
  let textW = tw(msg);
  let w = padL + dotR + gap + textW + padR, h = 36, r = 18;
  // keep the pill fully on-screen even when centred under the shrimp
  let x = constrain(cx - w / 2, 8, max(8, width - 8 - w));

  push();
  rectMode(CORNER);
  drawingContext.shadowColor = "rgba(61,43,36,0.20)";
  drawingContext.shadowBlur = 18;
  drawingContext.shadowOffsetY = 6;
  noStroke();
  fill(255, 248, 240, 238); // #FFF8F0
  rect(x, y - h / 2, w, h, r);
  drawingContext.shadowBlur = 0;
  drawingContext.shadowOffsetY = 0;
  noFill();
  stroke(240, 220, 201, 220);
  strokeWeight(1);
  rect(x, y - h / 2, w, h, r);
  pop();

  noStroke();
  fill(red(dotCol), green(dotCol), blue(dotCol));
  circle(x + padL + dotR / 2, y, dotR);

  fill(61, 43, 36);
  setFont(16, 400);
  inkText(msg, x + padL + dotR + gap, y, "left", "middle");
}

// ---------- helpers ----------

function fmt(ms) {
  let s = floor(ms / 1000);
  let m = floor(s / 60);
  s = s % 60;
  return m + ":" + nf(s, 2);
}

function postureConfidence(pose) {
  let need = ["nose", "left_shoulder", "right_shoulder"];
  let total = 0;
  for (let name of need) {
    let k = null;
    for (let p of pose.keypoints) if (p.name === name) k = p;
    if (!k) return 0;
    total += k.confidence;
  }
  return total / need.length;
}

function average(arr) {
  if (arr.length === 0) return 0;
  let sum = 0;
  for (let v of arr) sum += v;
  return sum / arr.length;
}

function getPoint(pose, name) {
  for (let k of pose.keypoints) {
    if (k.name === name && k.confidence > CONF) return k;
  }
  return null;
}
