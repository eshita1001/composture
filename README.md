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

**For Apple Silicon Macs (M1/M2/M3/M4).** Grab `Composture.dmg` from the [Releases](../../releases) page.

1. Open the `.dmg` and **drag Composture into Applications**.
2. **First launch only:** right-click (or two-finger click) **Composture → Open → Open**. macOS asks you to confirm because the app is signed but not App-Store-notarized — normal for free apps.
3. **Allow** camera access when prompted. Composture then lives in your **menu bar** (no dock icon).

*(If you ever see a "damaged" message, run `xattr -cr /Applications/Composture.app` in Terminal, then reopen.)*

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
