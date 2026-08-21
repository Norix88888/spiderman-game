/* =========================================================================
   game.js — 부팅 / 렌더러 / 입력 / HUD / 미니맵 / 사운드 / 메인 루프
   ========================================================================= */
(function () {
  const NS = (window.SPIDER = window.SPIDER || {});
  const $ = id => document.getElementById(id);
  const V3 = THREE.Vector3;

  const el = {
    canvas: $('scene'), speed: $('speed'), alt: $('alt'), best: $('best'),
    stateTag: $('stateTag'), scoreVal: $('scoreVal'), combo: $('combo'),
    suitName: $('suitName'), suitSwatch: $('suitSwatch'), cross: $('cross'),
    minimap: $('minimap'), toast: $('toast'), rush: $('rush'),
    boot: $('boot'), barFill: $('barFill'), bootMsg: $('bootMsg'),
    playBtn: $('playBtn'), err: $('err'), picker: $('picker'),
    suitGrid: $('suitGrid'), pause: $('pause'),
    objective: $('objective'), oName: $('oName'), oDist: $('oDist'),
    oLeft: $('oLeft'), oArrow: $('oArrow'),
    hpFill: $('hpFill'), hurt: $('hurt'),
    fcFill: $('fcFill'), abName: $('abName'),
    senseWrap: $('senseWrap'), comboBig: $('comboBig')
  };

  /* 터치 기기 판별 — 마우스가 없는(coarse pointer) 기기면 터치 UI */
  const FORCE_TOUCH = /[?&]touch=1/.test(location.search);   // PC에서 터치UI 테스트용
  const IS_TOUCH = FORCE_TOUCH ||
    (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) ||
    /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  const IS_SMALL = Math.min(screen.width, screen.height) < 820 ||
    Math.min(window.innerWidth, window.innerHeight) < 560;
  const MOBILE = IS_TOUCH && IS_SMALL;

  let renderer, scene, camera, composer, bloomPass, fxaaPass;
  let city, player, crime, combat, abilities, fx, mapCtx, mapImg;
  let running = false, started = false, paused = false;
  let score = 0, combo = 1, comboTimer = 0, quality = 2;
  const clock = { last: 0 };

  /* ------------------------------------------------------------ 사운드 */
  const sfx = (function () {
    let ac = null, wind = null, windGain = null, muted = false;
    function ctx() {
      if (muted) return null;
      if (!ac) {
        try { ac = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return null; }
      }
      if (ac.state === 'suspended') ac.resume();
      return ac;
    }
    function setMuted(v) {
      muted = v;
      if (windGain) windGain.gain.value = 0;
      return muted;
    }
    function noiseBuf(a, dur) {
      const n = Math.floor(a.sampleRate * dur);
      const b = a.createBuffer(1, n, a.sampleRate);
      const d = b.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
      return b;
    }
    return {
      thwip(rate) {
        const a = ctx(); if (!a) return;
        const s = a.createBufferSource(); s.buffer = noiseBuf(a, 0.22);
        const f = a.createBiquadFilter(); f.type = 'bandpass';
        f.frequency.setValueAtTime(2600 * (rate || 1), a.currentTime);
        f.frequency.exponentialRampToValueAtTime(600, a.currentTime + 0.2);
        f.Q.value = 4;
        const g = a.createGain();
        g.gain.setValueAtTime(0.28, a.currentTime);
        g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + 0.22);
        s.connect(f); f.connect(g); g.connect(a.destination); s.start();
      },
      miss() {
        const a = ctx(); if (!a) return;
        const s = a.createBufferSource(); s.buffer = noiseBuf(a, 0.1);
        const g = a.createGain(); g.gain.setValueAtTime(0.06, a.currentTime);
        g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + 0.1);
        s.connect(g); g.connect(a.destination); s.start();
      },
      land(k) {
        const a = ctx(); if (!a) return;
        const o = a.createOscillator(); o.type = 'sine';
        o.frequency.setValueAtTime(120, a.currentTime);
        o.frequency.exponentialRampToValueAtTime(38, a.currentTime + 0.25);
        const g = a.createGain();
        g.gain.setValueAtTime(0.18 + 0.3 * k, a.currentTime);
        g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + 0.3);
        o.connect(g); g.connect(a.destination); o.start(); o.stop(a.currentTime + 0.32);
      },
      jump() {
        const a = ctx(); if (!a) return;
        const o = a.createOscillator(); o.type = 'triangle';
        o.frequency.setValueAtTime(220, a.currentTime);
        o.frequency.exponentialRampToValueAtTime(520, a.currentTime + 0.12);
        const g = a.createGain();
        g.gain.setValueAtTime(0.07, a.currentTime);
        g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + 0.14);
        o.connect(g); g.connect(a.destination); o.start(); o.stop(a.currentTime + 0.15);
      },
      stick() { this.miss(); },
      pickup(pitch) {
        const a = ctx(); if (!a) return;
        const o = a.createOscillator(); o.type = 'square';
        o.frequency.setValueAtTime(660 * (pitch || 1), a.currentTime);
        o.frequency.setValueAtTime(990 * (pitch || 1), a.currentTime + 0.06);
        const g = a.createGain();
        g.gain.setValueAtTime(0.07, a.currentTime);
        g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + 0.18);
        o.connect(g); g.connect(a.destination); o.start(); o.stop(a.currentTime + 0.2);
      },
      toggleMute() { return setMuted(!muted); },
      get muted() { return muted; },
      windLevel(v) {
        const a = ctx(); if (!a) { if (windGain) windGain.gain.value = 0; return; }
        if (!wind) {
          wind = a.createBufferSource();
          wind.buffer = noiseBuf(a, 2); wind.loop = true;
          const f = a.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 700;
          windGain = a.createGain(); windGain.gain.value = 0;
          wind.connect(f); f.connect(windGain); windGain.connect(a.destination);
          wind.start();
        }
        windGain.gain.value += (Math.min(0.11, v * 0.11) - windGain.gain.value) * 0.08;
      }
    };
  })();
  NS.sfx = sfx;

  /* ------------------------------------------------------------- 입력 */
  const input = {
    moveX: 0, moveZ: 0, jump: false, jumpHeld: false, sprint: false,
    swingHeld: false, swingPressed: false, zipPressed: false,
    mouseX: 0, mouseY: 0
  };
  const keys = {};

  /* ------------------------------------------------------- 터치 컨트롤 */
  const touch = {
    stickId: null, ox: 0, oy: 0, mx: 0, mz: 0, mag: 0,
    lookId: null, lx: 0, ly: 0,
    swing: false, dive: false, jumpHeld: false
  };
  const STICK_R = 52;

  function bindTouch() {
    document.body.classList.add('touch');
    const stick = $('stick'), knob = $('knob');

    function setStick(x, y) {
      stick.style.left = x + 'px'; stick.style.top = y + 'px';
    }
    function setKnob(dx, dy) {
      knob.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
    }

    el.canvas.addEventListener('touchstart', e => {
      e.preventDefault();
      for (let i = 0; i < e.changedTouches.length; i++) {
        const t = e.changedTouches[i];
        if (t.clientX < window.innerWidth * 0.45 && touch.stickId === null) {
          touch.stickId = t.identifier;
          touch.ox = t.clientX; touch.oy = t.clientY;
          setStick(t.clientX, t.clientY); setKnob(0, 0);
          stick.classList.add('on');
        } else if (touch.lookId === null) {
          touch.lookId = t.identifier;
          touch.lx = t.clientX; touch.ly = t.clientY;
        }
      }
    }, { passive: false });

    el.canvas.addEventListener('touchmove', e => {
      e.preventDefault();
      for (let i = 0; i < e.changedTouches.length; i++) {
        const t = e.changedTouches[i];
        if (t.identifier === touch.stickId) {
          let dx = t.clientX - touch.ox, dy = t.clientY - touch.oy;
          const d = Math.hypot(dx, dy);
          if (d > STICK_R) { dx *= STICK_R / d; dy *= STICK_R / d; }
          setKnob(dx, dy);
          touch.mx = dx / STICK_R;
          touch.mz = -dy / STICK_R;
          touch.mag = Math.min(1, d / STICK_R);
        } else if (t.identifier === touch.lookId) {
          input.mouseX += (t.clientX - touch.lx) * 2.1;
          input.mouseY += (t.clientY - touch.ly) * 2.1;
          touch.lx = t.clientX; touch.ly = t.clientY;
        }
      }
    }, { passive: false });

    function endTouch(e) {
      for (let i = 0; i < e.changedTouches.length; i++) {
        const t = e.changedTouches[i];
        if (t.identifier === touch.stickId) {
          touch.stickId = null; touch.mx = 0; touch.mz = 0; touch.mag = 0;
          stick.classList.remove('on'); setKnob(0, 0);
        } else if (t.identifier === touch.lookId) touch.lookId = null;
      }
    }
    el.canvas.addEventListener('touchend', endTouch);
    el.canvas.addEventListener('touchcancel', endTouch);

    /* 버튼 */
    function btn(id, onDown, onUp) {
      const b = $(id);
      if (!b) return;
      b.addEventListener('touchstart', e => {
        e.preventDefault(); e.stopPropagation();
        b.classList.add('hit'); onDown && onDown();
      }, { passive: false });
      const up = e => {
        e.preventDefault(); e.stopPropagation();
        b.classList.remove('hit'); onUp && onUp();
      };
      b.addEventListener('touchend', up);
      b.addEventListener('touchcancel', up);
      b.addEventListener('click', e => e.preventDefault());
    }

    btn('bSwing', () => { input.swingHeld = true; input.swingPressed = true; },
      () => { input.swingHeld = false; });
    btn('bZip', () => { input.zipPressed = true; });
    btn('bJump', () => { input.jump = true; touch.jumpHeld = true; },
      () => { touch.jumpHeld = false; });
    btn('bDive', () => { touch.dive = true; }, () => { touch.dive = false; });
    btn('bPunch', doPunch);
    btn('bYank', doYank);
    btn('bDodge', doDodge);
    btn('bPower', doAbility);
    btn('bSuit', () => { togglePicker(); });
    btn('bPause', () => { setPaused(!paused); });
    btn('bMute', () => {
      const m = sfx.toggleMute();
      const b = $('bMute'); if (b) b.textContent = m ? '🔇' : '🔊';
    });

    function checkOrient() {
      document.body.classList.toggle('portrait',
        window.innerHeight > window.innerWidth * 1.05);
    }
    window.addEventListener('orientationchange', () => setTimeout(checkOrient, 250));
    window.addEventListener('resize', checkOrient);
    checkOrient();
  }

  function bindInput() {
    window.addEventListener('keydown', e => {
      if (e.code === 'Tab') { e.preventDefault(); togglePicker(); return; }
      if (keys[e.code]) return;
      keys[e.code] = true;
      if (e.code === 'Space') { input.jump = true; e.preventDefault(); }
      if (e.code === 'KeyR') player && player.respawn();
      if (e.code === 'KeyG') cycleQuality();
      if (e.code === 'KeyM') toast(sfx.toggleMute() ? '🔇 소리 끔' : '🔊 소리 켬');
      if (e.code === 'KeyF') doPunch();
      if (e.code === 'KeyE') doYank();
      if (e.code === 'KeyQ') doAbility();
      if (e.code === 'KeyC') doDodge();
      if (e.code === 'KeyP' || e.code === 'Escape') {
        if (el.picker.classList.contains('on')) togglePicker();
        else setPaused(!paused);
      }
      const n = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8'].indexOf(e.code);
      if (n >= 0) selectSuit(n);
    });
    window.addEventListener('keyup', e => { keys[e.code] = false; });

    if (IS_TOUCH) bindTouch();

    el.canvas.addEventListener('mousedown', e => {
      if (!started || IS_TOUCH) return;
      if (document.pointerLockElement !== el.canvas) { el.canvas.requestPointerLock(); return; }
      if (e.button === 0) { input.swingHeld = true; input.swingPressed = true; }
      if (e.button === 2) input.zipPressed = true;
    });
    window.addEventListener('mouseup', e => {
      if (e.button === 0) input.swingHeld = false;
    });
    window.addEventListener('contextmenu', e => e.preventDefault());
    // 마우스 잠금이 풀려도 시점은 계속 돌아가게 (잠금 실패/해제 시 폴백)
    document.addEventListener('mousemove', e => {
      if (!started || paused || IS_TOUCH) return;
      if (el.picker.classList.contains('on')) return;
      const locked = document.pointerLockElement === el.canvas;
      const mx = e.movementX || 0, my = e.movementY || 0;
      input.mouseX += locked ? mx : mx * 0.8;
      input.mouseY += locked ? my : my * 0.8;
    });
    // 창을 벗어났을 때만 일시정지 (포인터 잠금 해제로는 멈추지 않는다)
    window.addEventListener('blur', () => { if (started) setPaused(true); });
    window.addEventListener('resize', onResize);
  }

  /* ------------------------------------------------- 전투 / 능력 액션 */
  function doPunch() { if (combat && started && !paused) combat.punch(); }
  function doYank() { if (combat && started && !paused) combat.webYank(); }
  function doDodge() { if (combat && started && !paused) combat.dodge(); }
  function doAbility() {
    if (!abilities || !started || paused) return;
    if (abilities.trigger()) toast(abilities.name + ' 발동!', abilities.color);
    else toast('포커스 부족 (' + Math.round(abilities.energy * 100) + '%)', '#8b93a8');
  }

  function pollKeys() {
    input.moveZ = (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0);
    input.moveX = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0);
    input.sprint = !!(keys.ShiftLeft || keys.ShiftRight);
    input.jumpHeld = !!keys.Space;
    if (IS_TOUCH) {
      if (touch.jumpHeld) input.jumpHeld = true;
      if (touch.stickId !== null) {
        input.moveX = touch.mx;
        input.moveZ = touch.mz;
        if (touch.mag > 0.86) input.sprint = true;
      }
      if (touch.dive) input.sprint = true;
    }
  }

  function setPaused(v) {
    paused = v;
    el.pause.classList.toggle('on', v);
    if (v) { input.swingHeld = false; input.moveX = 0; input.moveZ = 0; }
  }

  /* 정지 화면을 누르면 무조건 재개 — 오버레이가 클릭을 먹어서
     영영 멈춰 있던 문제 방지 */
  function resume() {
    setPaused(false);
    if (!IS_TOUCH && started && document.pointerLockElement !== el.canvas) {
      try { el.canvas.requestPointerLock(); } catch (e) { }
    }
  }
  el.pause.addEventListener('mousedown', e => { e.preventDefault(); resume(); });
  el.pause.addEventListener('touchstart', e => { e.preventDefault(); resume(); }, { passive: false });

  /* -------------------------------------------------------- 슈트 선택 */
  let suitIndex = 0;
  function buildPicker() {
    NS.Suits.list.forEach((s, i) => {
      const d = document.createElement('div');
      d.className = 'suitCard' + (i === 0 ? ' sel' : '');
      d.innerHTML = '<div class="kx">' + (i + 1) + '</div>' +
        '<div class="sw" style="background-image:url(' + NS.Suits.swatch(s) + ');background-size:cover"></div>' +
        '<div class="nm">' + s.name + '</div><div class="ds">' + s.desc + '</div>';
      d.addEventListener('click', () => { selectSuit(i); togglePicker(); });
      el.suitGrid.appendChild(d);
    });
  }
  function selectSuit(i) {
    if (i < 0 || i >= NS.Suits.list.length) return;
    suitIndex = i;
    const s = NS.Suits.list[i];
    [].forEach.call(el.suitGrid.children, (c, k) => c.classList.toggle('sel', k === i));
    el.suitName.textContent = s.name;
    el.suitSwatch.style.backgroundImage = 'url(' + NS.Suits.swatch(s) + ')';
    el.suitSwatch.style.backgroundSize = 'cover';
    if (player) player.setSuit(s.id);
    if (abilities) abilities.setSuit(s.id);
    toast(s.name + ' — ' + (abilities ? abilities.name : s.desc), s.accent);
  }
  function togglePicker() {
    if (!started) return;
    const on = el.picker.classList.toggle('on');
    if (on) {
      if (!IS_TOUCH) document.exitPointerLock();
      setPaused(true);
    } else {
      if (!IS_TOUCH) el.canvas.requestPointerLock();
      else setPaused(false);
    }
  }

  /* ------------------------------------------------------------ 토스트 */
  let toastT = 0;
  function toast(msg, color) {
    el.toast.textContent = msg;
    el.toast.style.color = color || '#fff';
    el.toast.classList.add('on');
    toastT = 1.4;
  }

  /* ------------------------------------------------------------- 부팅 */
  function progress(v, msg) {
    el.barFill.style.width = (v * 100) + '%';
    if (msg) el.bootMsg.textContent = msg;
  }

  function fail(msg) {
    el.err.style.display = 'block';
    el.err.innerHTML = msg;
    el.bootMsg.textContent = '오류';
  }

  function initRenderer() {
    renderer = new THREE.WebGLRenderer({
      canvas: el.canvas, antialias: !MOBILE, powerPreference: 'high-performance'
    });
    renderer.setPixelRatio(MOBILE ? Math.min(window.devicePixelRatio, 1.15)
      : Math.min(window.devicePixelRatio, 1.6));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.82;
    renderer.shadowMap.enabled = !MOBILE;
    renderer.shadowMap.type = MOBILE ? THREE.BasicShadowMap : THREE.PCFSoftShadowMap;

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight,
      0.25, MOBILE ? 2200 : 3600);

    // 수집품 대신 범죄 시스템을 쓰므로 토큰/링은 0
    NS.City.configure({ TOKENS: 0, RINGS: 0 });
    if (MOBILE) {
      quality = 1;
      NS.City.configure({ GRID: 8, CARS: 45, LAMP_DENSITY: 2 });
    }
  }

  function initPost() {
    // 새 파이프라인(색보정·모션블러·색수차·비네트)이 있으면 그걸 쓴다
    if (NS.PostFX) {
      try {
        fx = NS.PostFX.create(renderer, scene, camera, { mobile: MOBILE });
        if (fx && fx.enabled) {
          fx.setQuality(quality);
          onResize();
          return;
        }
      } catch (e) { console.warn('PostFX 실패, 기본 파이프라인으로', e); fx = null; }
    }
    try {
      if (!THREE.EffectComposer) return;
      composer = new THREE.EffectComposer(renderer);
      composer.renderTarget1.texture.encoding = THREE.LinearEncoding;
      composer.renderTarget2.texture.encoding = THREE.LinearEncoding;
      composer.addPass(new THREE.RenderPass(scene, camera));
      bloomPass = new THREE.UnrealBloomPass(
        new THREE.Vector2(window.innerWidth * (MOBILE ? 0.5 : 1),
          window.innerHeight * (MOBILE ? 0.5 : 1)),
        MOBILE ? 0.38 : 0.55, 0.62, 0.82);
      composer.addPass(bloomPass);
      fxaaPass = new THREE.ShaderPass(THREE.FXAAShader);
      composer.addPass(fxaaPass);
      composer.addPass(new THREE.ShaderPass(THREE.GammaCorrectionShader));
      onResize();
    } catch (e) {
      console.warn('postprocessing 비활성', e);
      composer = null;
    }
  }

  function onResize() {
    if (!renderer) return;
    const w = window.innerWidth, h = window.innerHeight;
    camera.aspect = w / h; camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    if (fx && fx.enabled) { fx.setSize(w, h); return; }
    if (composer) {
      composer.setSize(w, h);
      const pr = renderer.getPixelRatio();
      if (fxaaPass) fxaaPass.material.uniforms.resolution.value.set(1 / (w * pr), 1 / (h * pr));
      if (bloomPass) bloomPass.resolution.set(w, h);
    }
  }

  function cycleQuality() {
    quality = (quality + 2) % 3;
    if (quality === 2) {
      renderer.shadowMap.enabled = true;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.6));
      if (bloomPass) bloomPass.enabled = true;
      toast('그래픽: 최고');
    } else if (quality === 1) {
      renderer.shadowMap.enabled = true;
      renderer.setPixelRatio(1);
      if (bloomPass) bloomPass.enabled = true;
      toast('그래픽: 보통');
    } else {
      renderer.shadowMap.enabled = false;
      renderer.setPixelRatio(0.85);
      if (bloomPass) bloomPass.enabled = false;
      toast('그래픽: 성능');
    }
    scene.traverse(o => { if (o.isMesh && o.material) o.material.needsUpdate = true; });
    onResize();
  }

  /* --------------------------------------------------------- 미니맵 */
  function initMap() {
    mapCtx = el.minimap.getContext('2d');
    mapImg = city.mapCanvas;
  }
  function drawMap() {
    const S = el.minimap.width;
    const VIEW = 400;                              // 표시 반경(m)
    const sc = mapImg.width / (city.HALF * 2);
    const sx = (player.pos.x + city.HALF) * sc, sy = (player.pos.z + city.HALF) * sc;
    const half = (VIEW / 2) * sc;
    mapCtx.fillStyle = '#080a10';
    mapCtx.fillRect(0, 0, S, S);
    mapCtx.drawImage(mapImg, sx - half, sy - half, half * 2, half * 2, 0, 0, S, S);

    const px = p => (p / VIEW) * S + S / 2;
    const clampEdge = v => Math.max(9, Math.min(S - 9, v));

    // 범죄 현장 (범위 밖이면 가장자리에 붙여 표시)
    crime.sites.forEach(s => {
      if (s.done) return;
      const dx = s.pos.x - player.pos.x, dz = s.pos.z - player.pos.z;
      const x = clampEdge(px(dx)), y = clampEdge(px(dz));
      mapCtx.fillStyle = 'rgba(255,43,60,.22)';
      mapCtx.beginPath(); mapCtx.arc(x, y, 15, 0, 6.3); mapCtx.fill();
      mapCtx.fillStyle = '#ff2b3c';
      mapCtx.beginPath(); mapCtx.arc(x, y, 6, 0, 6.3); mapCtx.fill();
    });
    // 범인
    crime.enemies.forEach(e => {
      if (e.arrested) return;
      const dx = e.pos.x - player.pos.x, dz = e.pos.z - player.pos.z;
      if (Math.abs(dx) > VIEW / 2 || Math.abs(dz) > VIEW / 2) return;
      mapCtx.fillStyle = '#ffb020';
      mapCtx.fillRect(px(dx) - 2.5, px(dz) - 2.5, 5, 5);
    });
    // 플레이어
    mapCtx.save();
    mapCtx.translate(S / 2, S / 2);
    mapCtx.rotate(-player.camYaw + Math.PI);
    mapCtx.fillStyle = '#fff';
    mapCtx.beginPath();
    mapCtx.moveTo(0, -11); mapCtx.lineTo(8, 9); mapCtx.lineTo(0, 4); mapCtx.lineTo(-8, 9);
    mapCtx.closePath(); mapCtx.fill();
    mapCtx.restore();
  }

  /* --------------------------------------------------------- 수집 판정 */
  const _v = new V3();
  function checkPickups(dt) {
    let got = false;
    const tl = city.tokens.list;
    for (let i = 0; i < tl.length; i++) {
      const t = tl[i];
      if (!t.alive) continue;
      if (t.pos.distanceToSquared(player.pos) < 22) {
        t.alive = false; got = true;
        score += 100 * combo;
        combo = Math.min(9, combo + 1); comboTimer = 5;
        player.sparks.burst(t.pos, 14, 1, 8);
        sfx.pickup(1 + combo * 0.06);
        toast('+' + (100 * (combo - 1)) + '  거미 토큰', '#ff6b78');
      }
    }
    const rl = city.rings.list;
    for (let i = 0; i < rl.length; i++) {
      const r = rl[i];
      if (!r.alive) continue;
      _v.subVectors(player.pos, r.pos);
      _v.y -= 1;
      const ax = Math.sin(r.rotY), az = Math.cos(r.rotY);
      const along = _v.x * ax + _v.z * az;
      if (Math.abs(along) < 2.2) {
        const rad = Math.sqrt(_v.lengthSq() - along * along);
        if (rad < 4.2) {
          r.alive = false;
          score += 500 * combo;
          combo = Math.min(9, combo + 1); comboTimer = 6;
          player.sparks.burst(r.pos, 26, 1.4, 12);
          sfx.pickup(1.5);
          toast('링 통과!  +' + (500 * combo), '#4fe6ff');
        }
      }
    }
    if (comboTimer > 0) {
      comboTimer -= dt;
      if (comboTimer <= 0) combo = 1;
    }
    el.combo.classList.toggle('on', combo > 1);
    if (combo > 1) el.combo.textContent = '×' + combo + ' 콤보';
    return got;
  }

  /* ------------------------------------------------- 화면 효과 연동 */
  function applyScreenFx(dt) {
    if (!fx || !fx.enabled) return;
    // 속도감 — 90km/h 부터 서서히, 240km/h 에서 최대
    const sp = Math.max(0, Math.min(1, (player.speedKmh - 90) / 150));
    fx.setSpeed(sp);
    fx.setDamage(crime.hurtFlash || 0);
    if (combat && combat.shake > 0.01) fx.setShake(combat.shake);
    if (abilities) {
      if (abilities.fxPulse > 0.6) fx.setPulse(1);
      fx.setTint(abilities.fxTint || null, abilities.fxTint ? 0.35 : 0, 'ability');
    }
  }

  /* ------------------------------------------------------------ HUD */
  const _cv = new V3();
  let hudT = 0, crossT = 0;
  function updateHUD(dt) {
    hudT += dt;
    if (hudT > 0.06) {
      hudT = 0;
      el.speed.textContent = Math.round(player.speedKmh);
      el.alt.textContent = Math.round(player.pos.y);
      el.best.textContent = Math.round(player.best);
      el.stateTag.textContent = player.stateLabel();
      el.scoreVal.textContent = crime.score.toLocaleString();

      // 목표 패널
      const s = crime.nearestSite;
      if (s) {
        const left = s.enemies.filter(e => !e.arrested).length;
        el.oName.textContent = s.done ? '현장 정리 완료' : s.name;
        el.oDist.textContent = Math.round(crime.nearestDist);
        el.oLeft.textContent = left;
        // 화면상 방향 화살표
        const ang = Math.atan2(s.pos.x - player.pos.x, s.pos.z - player.pos.z) - player.camYaw;
        el.oArrow.style.transform = 'rotate(' + (ang * 180 / Math.PI) + 'deg)';
        el.objective.style.display = '';
      } else el.objective.style.display = 'none';

      // 체력
      const hp = Math.max(0, crime.hp / crime.maxHp);
      el.hpFill.style.width = (hp * 100) + '%';
      el.hpFill.classList.toggle('low', hp < 0.3);

      // 콤보 (체포)
      el.combo.classList.toggle('on', crime.combo > 1);
      if (crime.combo > 1) el.combo.textContent = '×' + crime.combo + ' 연속 체포';

      // 포커스 게이지 + 슈트 능력 이름
      if (abilities) {
        const e2 = Math.max(0, Math.min(1, abilities.energy));
        el.fcFill.style.width = (e2 * 100) + '%';
        el.fcFill.style.background = abilities.color;
        el.fcFill.classList.toggle('full', e2 >= 1);
        el.abName.textContent = abilities.active
          ? abilities.name + ' ' + abilities.remain.toFixed(1) + 's'
          : abilities.name;
      }
    }

    // 전투 HUD (매 프레임 — 반응이 빨라야 함)
    if (combat) {
      el.senseWrap.classList.toggle('on', !!combat.canDodge && combat.invuln <= 0);
      const cc = combat.comboCount;
      el.comboBig.classList.toggle('on', cc > 1);
      if (cc > 1) el.comboBig.textContent = cc + ' HIT';
    }
    el.hurt.style.opacity = crime.hurtFlash * 0.9;
    if (crime.messageT > 0 && crime.message !== lastMsg) {
      lastMsg = crime.message;
      toast(crime.message, crime.messageColor);
    }
    if (crime.messageT <= 0) lastMsg = null;
    const rush = Math.max(0, Math.min(1, (player.speedKmh - 90) / 130));
    el.rush.style.opacity = rush * 0.9;
    sfx.windLevel(rush + (player.state === 'swing' ? 0.25 : 0));

    if (toastT > 0) {
      toastT -= dt;
      if (toastT <= 0) el.toast.classList.remove('on');
    }
    el.cross.classList.toggle('lock', !!crime.aimTarget() || player.web.on);
  }
  let lastMsg = null;

  /* ------------------------------------------------------------ 루프 */
  function frame(now) {
    requestAnimationFrame(frame);
    if (!running) return;
    const t = now * 0.001;
    let dt = t - clock.last;
    clock.last = t;
    if (dt > 0.1) dt = 0.1;
    if (dt <= 0) return;

    if (!paused) {
      // 한 프레임에서 예외가 나도 게임 전체가 멈추지 않도록 방어
      try {
        pollKeys();
        // 히트스톱(타격 순간 정지) + 슬로모 능력을 시간 배수로 반영
        let sdt = dt;
        if (combat) sdt *= combat.hitStop;
        if (abilities) sdt *= abilities.mods.timeScale;
        if (sdt > 0.1) sdt = 0.1;

        player.update(sdt, input);
        if (abilities) abilities.update(sdt, t);       // player 이후 · 카메라 이전
        player.updateCamera(camera, sdt);
        city.update(sdt, t, player.pos);
        crime.update(sdt, t);
        if (combat) combat.update(sdt, t);             // crime 이후
        applyScreenFx(dt);
        updateHUD(dt);
        drawMap();
      } catch (err) {
        errCount++;
        if (errCount <= 3) console.error('[frame]', err);
        if (errCount === 8) {
          toast('오류가 반복돼 안전 위치로 복귀합니다', '#ff5566');
          try { player.respawn(); } catch (e2) { }
          errCount = 0;
        }
      }
      input.jump = false;
      input.swingPressed = false;
      input.zipPressed = false;
      input.mouseX = 0; input.mouseY = 0;
    } else {
      input.mouseX = 0; input.mouseY = 0;
    }

    try {
      if (fx && fx.enabled) fx.render(dt);
      else if (composer && quality > 0) composer.render();
      else renderer.render(scene, camera);
    } catch (err) {
      if (errCount++ < 3) console.error('[render]', err);
      renderer.render(scene, camera);
    }
  }
  let errCount = 0;

  /* ------------------------------------------------------------ 시작 */
  function boot() {
    if (!window.THREE) {
      fail('three.js 를 불러오지 못했습니다.<br>vendor 폴더가 index.html 옆에 있는지 확인하세요.');
      return;
    }
    progress(0.05, '렌더러 초기화');
    if (IS_TOUCH) {
      const tips = document.getElementById('bootTips');
      if (tips) tips.innerHTML =
        '왼쪽 화면을 <b>끌어서 이동</b> · 오른쪽 화면을 <b>쓸어서 시점</b><br>' +
        '오른쪽 아래 <b>웹</b> 버튼을 누르고 있으면 스윙 · 놓으면 날아감<br>' +
        '스틱을 끝까지 밀면 질주 · <b>가로 모드</b>를 권장합니다';
    }
    initRenderer();
    buildPicker();

    setTimeout(() => {
      progress(0.15, '도시 생성 중 — 빌딩 배치');
      setTimeout(() => {
        try {
          city = NS.City.build(scene, progress);
        } catch (e) {
          console.error(e);
          fail('도시 생성 실패: ' + e.message);
          return;
        }
        progress(0.94, '스파이더맨 소환');
        setTimeout(() => {
          player = NS.Player.create(scene, city, NS.Suits.list[0].id);
          player.pos.set(0, 190, 0);
          crime = NS.Crime.create(scene, city, player);
          player.onWebFire = function () { return crime.tryWebShot(); };
          try {
            combat = NS.Combat.create(scene, player, crime);
          } catch (e) { console.warn('combat 비활성', e); combat = null; }
          try {
            abilities = NS.Abilities.create(scene, player, crime);
            player.mods = abilities.mods;      // player.js 가 물리에 반영
          } catch (e) { console.warn('abilities 비활성', e); abilities = null; }
          initMap();
          initPost();
          NS.dbg = { get player() { return player; }, get city() { return city; },
            get crime() { return crime; },
            get combat() { return combat; }, get abilities() { return abilities; },
            get fx() { return fx; },
            get renderer() { return renderer; }, get composer() { return composer; },
            get bloom() { return bloomPass; }, get camera() { return camera; },
            get scene() { return scene; }, input: input, keys: keys,
            setPaused: setPaused };
          progress(1, '준비 완료');
          el.bootMsg.textContent = '';
          el.playBtn.style.display = 'block';
          // 배경에서 미리 한 프레임
          running = true;
          clock.last = performance.now() * 0.001;
          player.updateCamera(camera, 0.016);
          requestAnimationFrame(frame);
        }, 30);
      }, 30);
    }, 30);
  }

  el.playBtn.addEventListener('click', () => {
    started = true;
    el.boot.classList.add('gone');
    setTimeout(() => { el.boot.style.display = 'none'; }, 700);
    if (IS_TOUCH) {
      // 전체화면 + 가로 고정 (지원하는 기기에서만)
      const de = document.documentElement;
      const rq = de.requestFullscreen || de.webkitRequestFullscreen;
      if (rq) { try { rq.call(de); } catch (e) { } }
      setTimeout(() => {
        if (screen.orientation && screen.orientation.lock) {
          try { screen.orientation.lock('landscape').catch(() => { }); } catch (e) { }
        }
      }, 300);
      toast('웹 버튼을 누르고 있으면 스윙!', '#ff6b78');
    } else {
      el.canvas.requestPointerLock();
      toast('좌클릭을 누르고 있으면 스윙!', '#ff6b78');
    }
    setPaused(false);
  });
  el.canvas.addEventListener('click', () => {
    if (IS_TOUCH) return;
    if (started && document.pointerLockElement !== el.canvas && !el.picker.classList.contains('on')) {
      el.canvas.requestPointerLock();
    }
  });

  bindInput();
  window.addEventListener('load', boot);
  if (document.readyState === 'complete') boot();
})();
