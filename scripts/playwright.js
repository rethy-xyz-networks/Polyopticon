'use strict';

// Runs Playwright (the e2e and perf suites). On Linux the app runs on a virtual X display
// (xvfb-run), never on the desktop: a compositor like Hyprland ignores the off-screen
// position POLYOPTICON_OFFSCREEN asks for and would show the test windows.
//
//   node scripts/playwright.js [playwright test args…]

const { spawnSync } = require('child_process');

const args = ['playwright', 'test', ...process.argv.slice(2)];
let cmd = 'npx', env = process.env;
if (process.platform === 'linux') {
  if (spawnSync('which', ['xvfb-run']).status !== 0) {
    console.error('The e2e tests need xvfb-run on Linux (Arch: pacman -S xorg-server-xvfb), so no window opens on the desktop.');
    process.exit(1);
  }
  env = { ...process.env, XDG_SESSION_TYPE: 'x11', ELECTRON_OZONE_PLATFORM_HINT: 'x11', POLYOPTICON_XVFB: '1' };
  delete env.WAYLAND_DISPLAY;
  args.unshift('-a', '-s', '-screen 0 1600x1000x24', 'npx');
  cmd = 'xvfb-run';
}
process.exit(spawnSync(cmd, args, { stdio: 'inherit', env }).status ?? 1);
