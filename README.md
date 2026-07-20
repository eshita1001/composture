# 🦐 Composture

A posture-detection desktop buddy for macOS. A little shrimp floats on your screen and watches how you sit — **sit up straight, or you'll cook him.**

Slouch and he slowly curls up, turns from grey to cooked pink, and looks scared. Keep slouching and he "dies" (X eyes, ghost). Sit up straight and hold it to bring him back. It all runs locally on your webcam — **no video ever leaves your Mac.**

## Features

- 🎥 Real-time posture tracking via your webcam (ml5.js BodyPose) — fully local, private
- 🦐 A floating, transparent, always-on-top shrimp that reacts to your posture
- 🔊 Sound cues as he cooks and revives (toggleable)
- ⏱️ Session stats — session time, current alive streak, and how many times you've cooked him
- 📋 A session history window and a menu-bar menu
- 🫧 Underwater ambience — idle bob, drift, bubbles (respects "Reduce Motion")
- Compact when idle, expands on hover to show the details

## Download

Grab the latest `Composture.dmg` (or `.zip`) from the [Releases](../../releases) page.

**First launch:** because the app isn't code-signed, macOS will block it the first time. **Right-click the app → Open → Open.** After that it opens normally. It lives in your **menu bar** (no dock icon).

## Run from source

Requires [Node.js](https://nodejs.org) (LTS).

```bash
npm install
npm start
```

Right-click the shrimp to recalibrate; use the menu-bar shrimp icon for sound, history, and quit.

## Built with

[Electron](https://www.electronjs.org/) · [p5.js](https://p5js.org/) · [ml5.js](https://ml5js.org/) · [Fredoka](https://fonts.google.com/specimen/Fredoka)

Made by **Eshita Akella**.
