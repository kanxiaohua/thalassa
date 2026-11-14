/* =====================================================================
 *  识海 · 音景（程序化合成，不依赖任何音频文件）
 * ---------------------------------------------------------------------
 *  为什么不用音频文件：
 *    file:// 双击打开时，音频文件要么被 CORS 拦住，要么让项目体积膨胀。
 *    这里全部用 Web Audio 实时合成，零资源、零网络、离线可用。
 *
 *  声音构成：
 *    1. drone  —— 55Hz / 82.5Hz / 110Hz 的极低音底噪，缓慢呼吸，像深海
 *    2. chime  —— 点开记忆时的一声铃（五声音阶，按记忆在星海里的次序定音高）
 *    3. brush  —— 拨开粒子时的气流噪声，强度跟拨动速度走
 *    4. reverb —— 用程序生成的脉冲响应做的混响，给声音留出空间
 *
 *  浏览器策略：AudioContext 必须由用户手势启动，所以 init() 在第一次
 *  点击 / 拖动 / 按键时才会真正发声。
 * ===================================================================== */

window.SeaAudio = (function () {
  'use strict';

  // 程序音景（低频垫音 / 铃声 / 气流声）。
  // 库里有真实配乐之后，这两层叠在一起会互相打架，所以默认关掉。
  // 想听回来：在 index.html 里 main.js 之前加 <script>window.SOUND_AMBIENCE = true;</script>
  var AMBIENCE = window.SOUND_AMBIENCE === true;

  var ctx = null;
  var master = null;      // 总音量（静音开关作用在这里）
  var dry = null;         // 干声
  var wet = null;         // 混响返回
  var convolver = null;
  var droneGain = null;
  var started = false;
  var enabled = true;
  var ready = false;
  var lastBrush = 0;

  // 五声音阶（宫商角徵羽），从 G3 起，避免出现刺耳的小二度
  var PENTA = [1, 9 / 8, 5 / 4, 3 / 2, 5 / 3];
  var BASE = 196.0;

  function makeIR(duration, decay) {
    var rate = ctx.sampleRate;
    var len = Math.floor(rate * duration);
    var buf = ctx.createBuffer(2, len, rate);
    for (var ch = 0; ch < 2; ch++) {
      var data = buf.getChannelData(ch);
      for (var i = 0; i < len; i++) {
        var t = i / len;
        // 早期反射 + 指数衰减的噪声尾巴
        var n = (Math.random() * 2 - 1) * Math.pow(1 - t, decay);
        data[i] = n * (1 - t * 0.15);
      }
    }
    return buf;
  }

  function noiseBuffer(duration) {
    var rate = ctx.sampleRate;
    var len = Math.max(1, Math.floor(rate * duration));
    var buf = ctx.createBuffer(1, len, rate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  function init() {
    if (!AMBIENCE) return false;      // 音景关着：所有 chime / brush / hover 都静默
    if (ready) {
      if (ctx.state === 'suspended' && ctx.resume) ctx.resume();
      return true;
    }
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;

    try {
      ctx = new AC();
    } catch (e) {
      return false;
    }

    master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);

    // 一点柔和的限幅，防止多个铃声叠加时爆音
    var comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 18;
    comp.ratio.value = 6;
    comp.attack.value = 0.02;
    comp.release.value = 0.35;
    comp.connect(master);

    dry = ctx.createGain();
    dry.gain.value = 0.85;
    dry.connect(comp);

    convolver = ctx.createConvolver();
    convolver.buffer = makeIR(3.2, 2.4);
    wet = ctx.createGain();
    wet.gain.value = 0.5;
    convolver.connect(wet);
    wet.connect(comp);

    ready = true;
    startDrone();

    if (ctx.state === 'suspended' && ctx.resume) ctx.resume();
    return true;
  }

  function startDrone() {
    if (!ready || started) return;
    started = true;

    droneGain = ctx.createGain();
    droneGain.gain.value = 0;
    droneGain.gain.setTargetAtTime(0.075, ctx.currentTime, 3.5);

    var lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 380;
    lp.Q.value = 0.7;

    var partials = [
      { f: 55, g: 1.0, type: 'sine' },
      { f: 82.5, g: 0.42, type: 'sine' },
      { f: 110.4, g: 0.16, type: 'triangle' },
      { f: 164.8, g: 0.05, type: 'sine' }
    ];

    partials.forEach(function (p) {
      var osc = ctx.createOscillator();
      osc.type = p.type;
      osc.frequency.value = p.f;
      var g = ctx.createGain();
      g.gain.value = p.g;
      osc.connect(g);
      g.connect(lp);
      osc.start();
    });

    // 极慢的滤波扫动：让底噪像潮水一样起伏
    var lfo = ctx.createOscillator();
    lfo.frequency.value = 0.035;
    var lfoGain = ctx.createGain();
    lfoGain.gain.value = 120;
    lfo.connect(lfoGain);
    lfoGain.connect(lp.frequency);
    lfo.start();

    lp.connect(droneGain);
    droneGain.connect(dry);
    var send = ctx.createGain();
    send.gain.value = 0.35;
    droneGain.connect(send);
    send.connect(convolver);
  }

  /** 一声铃：分音叠加 + 长衰减，音高落在五声音阶上 */
  function chime(step, opt) {
    if (!ready || !enabled) return;
    opt = opt || {};
    var t0 = ctx.currentTime + (opt.delay || 0);
    var base = BASE * (opt.octave || 1);
    var deg = Math.abs(step) % 5;
    var oct = Math.floor((Math.abs(step) % 15) / 5);
    var freq = base * PENTA[deg] * Math.pow(2, oct);

    var out = ctx.createGain();
    out.gain.value = 0;
    var peak = opt.gain === undefined ? 0.16 : opt.gain;
    var dur = opt.dur || 2.6;

    out.gain.setValueAtTime(0, t0);
    out.gain.linearRampToValueAtTime(peak, t0 + 0.012);
    out.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    var partials = [
      { m: 1, g: 1.0 },
      { m: 2.01, g: 0.30 },
      { m: 3.02, g: 0.10 },
      { m: 4.72, g: 0.045 }
    ];

    partials.forEach(function (p) {
      var osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq * p.m;
      var g = ctx.createGain();
      g.gain.value = p.g;
      osc.connect(g);
      g.connect(out);
      osc.start(t0);
      osc.stop(t0 + dur + 0.1);
    });

    out.connect(dry);
    var send = ctx.createGain();
    send.gain.value = 0.85;
    out.connect(send);
    send.connect(convolver);
  }

  /** 拨动粒子的气流声，强度 0~1 */
  function brush(intensity) {
    if (!ready || !enabled) return;
    var now = ctx.currentTime;
    if (now - lastBrush < 0.075) return;   // 限流，避免密集触发糊成噪音
    lastBrush = now;

    var amp = Math.min(0.2, 0.035 + intensity * 0.16);
    if (amp < 0.02) return;

    var src = ctx.createBufferSource();
    src.buffer = noiseBuffer(0.5);

    var bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.4;
    var f0 = 700 + intensity * 1500;
    bp.frequency.setValueAtTime(f0, now);
    bp.frequency.exponentialRampToValueAtTime(f0 * 0.55, now + 0.35);

    var g = ctx.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(amp, now + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.42);

    src.connect(bp);
    bp.connect(g);
    g.connect(dry);
    var send = ctx.createGain();
    send.gain.value = 0.4;
    g.connect(send);
    send.connect(convolver);

    src.start(now);
    src.stop(now + 0.5);
  }

  /** 悬停：比 brush 更轻更短的一下，只在进入光点时触发 */
  function hover() {
    if (!ready || !enabled) return;
    var now = ctx.currentTime;
    if (now - lastBrush < 0.16) return;
    lastBrush = now;

    var osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1500, now);
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(0.018, now + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);
    osc.connect(g);
    g.connect(dry);
    osc.start(now);
    osc.stop(now + 0.25);
  }

  /** 面板收起时的一声低音 */
  function close() {
    chime(0, { gain: 0.10, dur: 2.0, octave: 0.5 });
  }

  /** 潮汐：一声极低的涌动，像远处的潮水推过来又退回去 */
  var lastSwell = 0;
  function swell(intensity) {
    if (!ready || !enabled) return;
    var now = ctx.currentTime;
    if (now - lastSwell < 4) return;   // 潮汐不会太密，限流一下
    lastSwell = now;

    var src = ctx.createBufferSource();
    src.buffer = noiseBuffer(4.4);

    var lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 1.2;
    lp.frequency.setValueAtTime(150, now);
    lp.frequency.linearRampToValueAtTime(430, now + 1.5);
    lp.frequency.linearRampToValueAtTime(130, now + 4.2);

    var g = ctx.createGain();
    var amp = 0.085 * (0.55 + intensity * 0.7);
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(amp, now + 1.5);
    g.gain.linearRampToValueAtTime(0.0001, now + 4.3);

    src.connect(lp);
    lp.connect(g);
    g.connect(dry);

    var send = ctx.createGain();
    send.gain.value = 0.9;
    g.connect(send);
    send.connect(convolver);

    src.start(now);
    src.stop(now + 4.4);
  }

  function setEnabled(v) {
    enabled = !!v;
    if (!ready) return;
    var target = enabled ? 0.9 : 0;
    master.gain.setTargetAtTime(target, ctx.currentTime, 0.25);
  }

  function toggle() {
    setEnabled(!enabled);
    return enabled;
  }

  function unmuteIfNeeded() {
    if (!ready) return;
    master.gain.setTargetAtTime(enabled ? 0.9 : 0, ctx.currentTime, 0.8);
  }

  return {
    init: init,
    chime: chime,
    brush: brush,
    hover: hover,
    swell: swell,
    close: close,
    setEnabled: setEnabled,
    toggle: toggle,
    isEnabled: function () { return enabled; },
    isReady: function () { return ready; },
    unmuteIfNeeded: unmuteIfNeeded
  };
})();
