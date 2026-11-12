// Plays the stream named in the page's link (?u=rtmp://…): /flv is that stream as FLV (main/rtmp.js).
// When it ends or can't be reached, the reason is shown and it is tried again, less and less often.

/* global mpegts */
const video = document.getElementById('video'), note = document.getElementById('note');
const source = new URLSearchParams(location.search).get('u') || '';
const RETRY_MS = [3000, 5000, 10_000, 30_000];
let player = null, tries = 0, timer = null;

function stop() {
  if (!player) return;
  try { player.destroy(); } catch { /* already gone */ }
  player = null;
}

function retry(why) {
  if (timer) return;
  stop();
  const wait = RETRY_MS[Math.min(tries++, RETRY_MS.length - 1)];
  note.textContent = `${why} Trying again in ${wait / 1000} s…`;
  timer = setTimeout(() => { timer = null; start(); }, wait);
}

function start() {
  note.textContent = 'Connecting…';
  player = mpegts.createPlayer(
    { type: 'flv', isLive: true, url: `${location.origin}/flv?u=${encodeURIComponent(source)}` },
    { enableWorker: false, enableStashBuffer: false, liveBufferLatencyChasing: true, liveBufferLatencyMaxLatency: 6, liveBufferLatencyMinRemain: 1.5 });
  player.attachMediaElement(video);
  // The server's reason arrives as the status text of the failed request.
  player.on(mpegts.Events.ERROR, (_type, _detail, info) => retry(info?.msg && !/^(OK|undefined)?$/.test(info.msg) ? `${info.msg}.` : 'The stream could not be played.'));
  player.on(mpegts.Events.LOADING_COMPLETE, () => retry('The stream ended.'));
  player.load();
  player.play()?.catch(() => { /* shown paused; the controls start it */ });
}

video.addEventListener('playing', () => { note.textContent = ''; tries = 0; });
start();
