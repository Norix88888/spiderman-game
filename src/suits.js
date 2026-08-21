/* =========================================================================
   suits.js  —  슈트 정의 + 절차적 텍스처 생성
   외부 이미지 없이 캔버스에 거미줄 패턴 / 엠블럼을 직접 그려서
   각 슈트의 재질(메탈/발광/무광)까지 다르게 만든다.
   ========================================================================= */
(function () {
  const NS = (window.SPIDER = window.SPIDER || {});

  /* ---------------------------------------------------------------- utils */
  function cv(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }
  function toTex(canvas, repX, repY) {
    const t = new THREE.CanvasTexture(canvas);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repX || 1, repY || 1);
    t.anisotropy = 8;
    t.encoding = THREE.sRGBEncoding;
    return t;
  }
  function shade(hex, amt) {
    const c = new THREE.Color(hex);
    const hsl = {}; c.getHSL(hsl);
    c.setHSL(hsl.h, hsl.s, Math.max(0, Math.min(1, hsl.l + amt)));
    return '#' + c.getHexString();
  }

  /* 진짜 거미줄: 중심에서 뻗는 방사선 + 안쪽으로 처진 나선 고리 */
  function drawWebNet(ctx, cx, cy, R, o) {
    const spokes = o.spokes || 16, rings = o.rings || 10;
    ctx.save();
    ctx.strokeStyle = o.color;
    ctx.lineCap = 'round';
    ctx.globalAlpha = o.alpha == null ? 0.8 : o.alpha;

    ctx.lineWidth = o.lw || 2;
    for (let i = 0; i < spokes; i++) {
      const a = (i / spokes) * Math.PI * 2 + (o.rot || 0);
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * R * 0.02, cy + Math.sin(a) * R * 0.02);
      ctx.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
      ctx.stroke();
    }

    ctx.lineWidth = (o.lw || 2) * 0.8;
    for (let r = 1; r <= rings; r++) {
      const rad = R * Math.pow(r / rings, o.curve || 1.35);
      ctx.beginPath();
      for (let i = 0; i < spokes; i++) {
        const a0 = (i / spokes) * Math.PI * 2 + (o.rot || 0);
        const a1 = ((i + 1) / spokes) * Math.PI * 2 + (o.rot || 0);
        const x0 = cx + Math.cos(a0) * rad, y0 = cy + Math.sin(a0) * rad;
        const x1 = cx + Math.cos(a1) * rad, y1 = cy + Math.sin(a1) * rad;
        const am = (a0 + a1) / 2, sag = rad * 0.87;      // 안쪽으로 처짐
        const xm = cx + Math.cos(am) * sag, ym = cy + Math.sin(am) * sag;
        if (i === 0) ctx.moveTo(x0, y0);
        ctx.quadraticCurveTo(2 * xm - (x0 + x1) / 2, 2 * ym - (y0 + y1) / 2, x1, y1);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  /* 각진 테크 패턴 (2099 / 아이언 스파이더용) */
  function drawTechLines(ctx, W, H, o) {
    ctx.save();
    ctx.strokeStyle = o.color;
    ctx.globalAlpha = o.alpha == null ? 0.75 : o.alpha;
    ctx.lineWidth = o.lw || 3;
    ctx.lineCap = 'round';
    const step = o.step || 46;
    for (let i = -H; i < W + H; i += step) {
      ctx.beginPath();
      ctx.moveTo(i, 0);
      ctx.lineTo(i + H * 0.42, H * 0.5);
      ctx.lineTo(i, H);
      ctx.stroke();
    }
    ctx.globalAlpha = (o.alpha == null ? 0.75 : o.alpha) * 0.5;
    for (let y = step * 0.5; y < H; y += step * 1.6) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }
    ctx.restore();
  }

  /* 거미 엠블럼 (몸통 + 8다리) */
  function drawSpider(ctx, cx, cy, s, color, style) {
    style = style || 'classic';
    ctx.save();
    ctx.translate(cx, cy);
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const long = style === 'symbiote';
    const legLen = s * (long ? 2.15 : 1.25);
    const lw = s * (long ? 0.13 : 0.115);

    // 다리 8개
    ctx.lineWidth = lw;
    const spread = long ? 1.32 : 1.02;
    for (let side = -1; side <= 1; side += 2) {
      for (let i = 0; i < 4; i++) {
        const t = i / 3;
        const upA = (-0.62 + t * 1.34) * spread;
        const bx = side * s * 0.16, by = -s * 0.28 + t * s * 0.55;
        const kx = bx + side * legLen * 0.46 * Math.cos(upA * 0.4);
        const ky = by - legLen * 0.42 * Math.cos(upA) * (i < 2 ? 1 : 0.15);
        const ex = bx + side * legLen * Math.cos(upA * 0.28);
        const ey = by + legLen * Math.sin(upA) * 0.95;
        ctx.beginPath();
        ctx.moveTo(bx, by);
        ctx.quadraticCurveTo(kx, ky, ex, ey);
        ctx.stroke();
      }
    }
    // 몸통
    ctx.beginPath();
    ctx.ellipse(0, s * 0.34, s * 0.235, s * 0.42, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(0, -s * 0.2, s * 0.165, s * 0.26, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(0, -s * 0.46, s * 0.1, s * 0.11, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /* 2099 해골형 엠블럼 */
  function drawSkullSpider(ctx, cx, cy, s, color) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.fillStyle = color; ctx.strokeStyle = color;
    ctx.lineWidth = s * 0.14; ctx.lineCap = 'round';
    for (let side = -1; side <= 1; side += 2) {
      for (let i = 0; i < 4; i++) {
        const t = i / 3;
        ctx.beginPath();
        ctx.moveTo(side * s * 0.1, -s * 0.1 + t * s * 0.3);
        ctx.quadraticCurveTo(side * s * (0.9 + t * 0.5), -s * (0.55 - t * 1.1),
                             side * s * (1.5 + t * 0.35), s * (-0.2 + t * 1.5));
        ctx.stroke();
      }
    }
    ctx.beginPath(); ctx.ellipse(0, 0, s * 0.42, s * 0.5, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  /* 천 질감 + 음영 */
  function fabricPass(ctx, W, H, dark) {
    const img = ctx.getImageData(0, 0, W, H), d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const n = (Math.random() - 0.5) * 16;
      d[i] += n; d[i + 1] += n; d[i + 2] += n;
    }
    ctx.putImageData(img, 0, 0);
    // 세로 음영(원통형 바디 느낌)
    const g = ctx.createLinearGradient(0, 0, W, 0);
    g.addColorStop(0.0, 'rgba(0,0,0,.55)');
    g.addColorStop(0.22, 'rgba(0,0,0,.12)');
    g.addColorStop(0.5, 'rgba(255,255,255,.10)');
    g.addColorStop(0.78, 'rgba(0,0,0,.12)');
    g.addColorStop(1.0, 'rgba(0,0,0,.55)');
    ctx.globalAlpha = dark ? 0.55 : 0.42;
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = 1;
  }

  /* ---------------------------------------------------------- suit 정의 */
  /* part 매핑 키: head chest abdomen upperArm forearm hand thigh shin foot */
  const SUITS = [
    {
      id: 'classic', name: '클래식', desc: '오리지널 레드/블루 웹 슈트',
      primary: '#c8102e', secondary: '#1b2f7a', accent: '#c8102e',
      web: '#0b0d18', webAlpha: 0.85, pattern: 'web',
      emblem: 'classic', emblemColor: '#0b0d18',
      metal: 0.05, rough: 0.62, glow: 0, eye: 'classic',
      eyeColor: '#ffffff', eyeRim: '#0a0c14',
      parts: { head: 'p', chest: 'p', abdomen: 's', upperArm: 'p', forearm: 'p', hand: 'p', thigh: 's', shin: 's', foot: 'p' }
    },
    {
      id: 'advanced', name: '어드밴스드', desc: '화이트 스파이더 · 광택 패널',
      primary: '#d81c2b', secondary: '#101a3c', accent: '#f2f5ff',
      web: '#12162a', webAlpha: 0.6, pattern: 'web',
      emblem: 'classic', emblemColor: '#f2f5ff',
      metal: 0.32, rough: 0.33, glow: 0, eye: 'classic',
      eyeColor: '#ffffff', eyeRim: '#f2f5ff',
      parts: { head: 'p', chest: 'p', abdomen: 'p', upperArm: 's', forearm: 's', hand: 'a', thigh: 's', shin: 's', foot: 'a' }
    },
    {
      id: 'symbiote', name: '심비오트', desc: '검은 외계 생명체 · 거대 엠블럼',
      primary: '#0a0a12', secondary: '#14141f', accent: '#e8ecff',
      web: '#2a2a3a', webAlpha: 0.35, pattern: 'web',
      emblem: 'symbiote', emblemColor: '#e8ecff',
      metal: 0.18, rough: 0.24, glow: 0, eye: 'wide',
      eyeColor: '#ffffff', eyeRim: '#000000',
      parts: { head: 'p', chest: 'p', abdomen: 'p', upperArm: 'p', forearm: 'p', hand: 'p', thigh: 's', shin: 's', foot: 'p' }
    },
    {
      id: 'iron', name: '아이언 스파이더', desc: '나노 장갑 · 4개의 기계 팔',
      primary: '#a3151f', secondary: '#111324', accent: '#d9a516',
      web: '#d9a516', webAlpha: 0.5, pattern: 'tech',
      emblem: 'gold', emblemColor: '#e9be3a',
      metal: 0.85, rough: 0.26, glow: 0.25, glowColor: '#ffb020',
      eye: 'sharp', eyeColor: '#ffd257', eyeRim: '#141422',
      arms: true,
      parts: { head: 'p', chest: 'p', abdomen: 'a', upperArm: 'a', forearm: 'p', hand: 'a', thigh: 'p', shin: 'a', foot: 'a' }
    },
    {
      id: 'miles', name: '마일즈 모랄레스', desc: '벤전스 · 붉은 발광 라인',
      primary: '#0b0b14', secondary: '#101020', accent: '#e01530',
      web: '#e01530', webAlpha: 0.55, pattern: 'web',
      emblem: 'classic', emblemColor: '#e01530',
      metal: 0.15, rough: 0.42, glow: 1.15, glowColor: '#ff1030',
      eye: 'wide', eyeColor: '#ffffff', eyeRim: '#e01530',
      parts: { head: 'p', chest: 'p', abdomen: 'p', upperArm: 'p', forearm: 'p', hand: 'a', thigh: 'p', shin: 'p', foot: 'a' }
    },
    {
      id: 'noir', name: '느와르 스텔스', desc: '무광 방탄천 · 야간 잠행',
      primary: '#14161f', secondary: '#0b0c12', accent: '#3d4a63',
      web: '#232838', webAlpha: 0.45, pattern: 'web',
      emblem: 'classic', emblemColor: '#080910',
      metal: 0.02, rough: 0.94, glow: 0.15, glowColor: '#7fe3ff',
      eye: 'goggle', eyeColor: '#9fe8ff', eyeRim: '#05060a',
      parts: { head: 'p', chest: 'p', abdomen: 's', upperArm: 's', forearm: 'a', hand: 's', thigh: 's', shin: 's', foot: 'a' }
    },
    {
      id: 's2099', name: '스파이더맨 2099', desc: '미래형 · 각진 테크 패턴',
      primary: '#101a5e', secondary: '#0a0f38', accent: '#e2223a',
      web: '#3f5bd6', webAlpha: 0.7, pattern: 'tech',
      emblem: 'skull', emblemColor: '#e2223a',
      metal: 0.42, rough: 0.3, glow: 0.8, glowColor: '#ff2a44',
      eye: 'sharp', eyeColor: '#ff3348', eyeRim: '#050818',
      parts: { head: 'p', chest: 'p', abdomen: 'p', upperArm: 's', forearm: 'a', hand: 'a', thigh: 's', shin: 's', foot: 'a' }
    },
    {
      id: 'gwen', name: '스파이더 그웬', desc: '화이트 후드 · 발레 슈즈',
      primary: '#f0f3ff', secondary: '#0d0f1c', accent: '#ff5fa8',
      web: '#20263d', webAlpha: 0.35, pattern: 'web',
      emblem: 'classic', emblemColor: '#0d0f1c',
      metal: 0.1, rough: 0.55, glow: 0.5, glowColor: '#4fe6ff',
      eye: 'wide', eyeColor: '#ffffff', eyeRim: '#0d0f1c',
      hood: true,
      parts: { head: 's', chest: 's', abdomen: 's', upperArm: 's', forearm: 'p', hand: 'p', thigh: 's', shin: 's', foot: 'p' }
    }
  ];

  /* ------------------------------------------------- 텍스처 / 재질 생성 */
  function panelCanvas(suit, color, opt) {
    opt = opt || {};
    const W = opt.size || 512, H = opt.size || 512;
    const c = cv(W, H), ctx = c.getContext('2d');
    ctx.fillStyle = color; ctx.fillRect(0, 0, W, H);

    // 미묘한 패널 분할
    ctx.globalAlpha = 0.16;
    ctx.fillStyle = shade(color, -0.07);
    for (let i = 0; i < 5; i++) {
      const y = (i / 5) * H + Math.random() * 20;
      ctx.fillRect(0, y, W, 6);
    }
    ctx.globalAlpha = 1;

    if (suit.pattern === 'tech') {
      drawTechLines(ctx, W, H, { color: suit.web, alpha: suit.webAlpha, lw: opt.lw || 3, step: 52 });
    } else {
      const cx = opt.cx == null ? W * 0.5 : opt.cx;
      const cy = opt.cy == null ? H * 0.5 : opt.cy;
      const R = opt.R || W * 0.95;
      drawWebNet(ctx, cx, cy, R, {
        color: suit.web, alpha: suit.webAlpha, lw: opt.lw || 2.4,
        spokes: opt.spokes || 18, rings: opt.rings || 11, rot: opt.rot || 0
      });
    }

    if (opt.emblem) {
      const es = W * (suit.emblem === 'symbiote' ? 0.2 : 0.155);
      const ey = H * (suit.emblem === 'symbiote' ? 0.46 : 0.4);
      if (suit.emblem === 'skull') drawSkullSpider(ctx, W * 0.5, ey, es * 0.9, suit.emblemColor);
      else drawSpider(ctx, W * 0.5, ey, es, suit.emblemColor, suit.emblem === 'symbiote' ? 'symbiote' : 'classic');
      // 등 쪽(텍스처 좌우 끝)에 작은 거미
      const bs = es * 0.62;
      if (suit.emblem !== 'skull') {
        drawSpider(ctx, 0, H * 0.42, bs, suit.emblemColor, 'classic');
        drawSpider(ctx, W, H * 0.42, bs, suit.emblemColor, 'classic');
      }
    }

    fabricPass(ctx, W, H, opt.dark);
    return c;
  }

  function glowCanvas(suit, color) {
    // accent 파트의 발광 마스크 (라인만 빛남)
    const W = 256, H = 256;
    const c = cv(W, H), ctx = c.getContext('2d');
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    if (suit.pattern === 'tech') {
      drawTechLines(ctx, W, H, { color: color, alpha: 1, lw: 4, step: 30 });
    } else {
      drawWebNet(ctx, W * 0.5, H * 0.4, W * 0.95, {
        color: color, alpha: 1, lw: 3, spokes: 14, rings: 9
      });
    }
    return c;
  }

  const cache = {};

  function buildMaterials(suit) {
    if (cache[suit.id]) return cache[suit.id];

    const mk = (canvas, color, isAccent) => {
      const m = new THREE.MeshStandardMaterial({
        map: toTex(canvas, 1, 1),
        roughness: suit.rough,
        metalness: suit.metal,
        color: 0xffffff
      });
      if (suit.glow > 0 && isAccent) {
        m.emissive = new THREE.Color(suit.glowColor || color);
        m.emissiveIntensity = suit.glow;
        m.emissiveMap = toTex(glowCanvas(suit, '#ffffff'), 1, 1);
      }
      return m;
    };

    const torsoCv = panelCanvas(suit, suit.primary, { emblem: true, size: 512, R: 560, spokes: 20, rings: 12 });
    const absCv = panelCanvas(suit, suit.parts.abdomen === 's' ? suit.secondary : suit.primary,
      { size: 256, cx: 128, cy: -60, R: 430, lw: 1.8 });

    const mats = {
      p: mk(panelCanvas(suit, suit.primary, { size: 256, cx: 128, cy: -70, R: 460, lw: 1.9 }), suit.primary, false),
      s: mk(panelCanvas(suit, suit.secondary, { size: 256, cx: 128, cy: 330, R: 460, lw: 1.9, dark: true }), suit.secondary, false),
      a: mk(panelCanvas(suit, suit.accent, { size: 256, cx: 128, cy: 128, R: 300, lw: 2.2 }), suit.accent, true),
      torso: mk(torsoCv, suit.primary, false),
      abdomen: mk(absCv, suit.secondary, false),
      head: mk(panelCanvas(suit, suit.parts.head === 's' ? suit.secondary : suit.primary,
        { size: 256, cx: 128, cy: 96, R: 250, lw: 2.1, spokes: 16, rings: 9 }), suit.primary, false),
      eye: new THREE.MeshStandardMaterial({
        color: new THREE.Color(suit.eyeColor),
        emissive: new THREE.Color(suit.eyeColor),
        emissiveIntensity: suit.eye === 'goggle' ? 1.4 : 0.45,
        roughness: 0.12, metalness: 0.1
      }),
      eyeRim: new THREE.MeshStandardMaterial({
        color: new THREE.Color(suit.eyeRim), roughness: 0.35, metalness: 0.3,
        emissive: new THREE.Color(suit.eyeRim),
        emissiveIntensity: suit.id === 'miles' ? 1.2 : 0
      }),
      metalTrim: new THREE.MeshStandardMaterial({
        color: new THREE.Color(suit.accent), roughness: 0.22, metalness: 0.92,
        emissive: new THREE.Color(suit.glowColor || suit.accent),
        emissiveIntensity: suit.glow * 0.6
      })
    };
    cache[suit.id] = mats;
    return mats;
  }

  NS.Suits = {
    list: SUITS,
    byId: function (id) { return SUITS.find(s => s.id === id) || SUITS[0]; },
    materials: buildMaterials,
    /* 슈트 카드 미리보기용 스와치 */
    swatch: function (suit) {
      const c = cv(120, 60), ctx = c.getContext('2d');
      const g = ctx.createLinearGradient(0, 0, 120, 60);
      g.addColorStop(0, suit.primary); g.addColorStop(0.55, suit.secondary);
      g.addColorStop(1, suit.accent);
      ctx.fillStyle = g; ctx.fillRect(0, 0, 120, 60);
      if (suit.pattern === 'tech') drawTechLines(ctx, 120, 60, { color: suit.web, alpha: suit.webAlpha, lw: 1.4, step: 16 });
      else drawWebNet(ctx, 60, 30, 90, { color: suit.web, alpha: suit.webAlpha, lw: 1, spokes: 12, rings: 7 });
      if (suit.emblem === 'skull') drawSkullSpider(ctx, 60, 30, 11, suit.emblemColor);
      else drawSpider(ctx, 60, 28, 17, suit.emblemColor, suit.emblem === 'symbiote' ? 'symbiote' : 'classic');
      return c.toDataURL();
    },
    _drawWebNet: drawWebNet
  };
})();
