/* =========================================================================
   city.js — 절차적 도시 생성
   창문이 켜진 고층빌딩 / 옥탑 설비 / 네온 / 가로등 / 달리는 차 / 하늘
   충돌은 메시가 아니라 AABB + 공간 격자로 처리해서 아주 빠르다.
   ========================================================================= */
(function () {
  const NS = (window.SPIDER = window.SPIDER || {});
  const BGU = THREE.BufferGeometryUtils || window.BufferGeometryUtils;
  const V3 = THREE.Vector3;

  const CFG = {
    GRID: 11,          // 블록 개수 (한 변)
    BLOCK: 78,         // 블록 크기
    STREET: 26,        // 도로 폭
    TILE: 6,           // 벽 텍스처 1타일 = 6m
    ROOF_TILE: 8,
    CARS: 150, TOKENS: 90, RINGS: 26, LAMP_DENSITY: 3
  };
  let PITCH = CFG.BLOCK + CFG.STREET;
  let HALF = (CFG.GRID * PITCH) / 2;

  /* 모바일 등에서 도시 규모를 줄일 때 사용 */
  function configure(opt) {
    for (const k in opt) if (k in CFG) CFG[k] = opt[k];
    PITCH = CFG.BLOCK + CFG.STREET;
    HALF = (CFG.GRID * PITCH) / 2;
  }

  /* ------------------------------------------------------------ 난수 */
  let seed = 20260821;
  function rnd() { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; }
  function rr(a, b) { return a + rnd() * (b - a); }
  function ri(a, b) { return Math.floor(rr(a, b + 0.999)); }

  /* -------------------------------------------------------- 텍스처들 */
  function cvs(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  function mkTex(c, r) {
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8; t.encoding = THREE.sRGBEncoding;
    if (r) t.repeat.set(r, r);
    return t;
  }

  /* 창문 타일: 알베도 + 발광맵 */
  function windowTiles(variant) {
    const S = 256, cols = 4, rows = 4;
    const a = cvs(S, S), ac = a.getContext('2d');
    const e = cvs(S, S), ec = e.getContext('2d');

    const wallCols = ['#2a2f3d', '#232733', '#343a49', '#1d2029', '#3a3f4e'];
    const wall = wallCols[variant % wallCols.length];
    ac.fillStyle = wall; ac.fillRect(0, 0, S, S);
    ec.fillStyle = '#000'; ec.fillRect(0, 0, S, S);

    // 콘크리트 노이즈
    const img = ac.getImageData(0, 0, S, S), d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const n = (Math.random() - 0.5) * 26;
      d[i] += n; d[i + 1] += n; d[i + 2] += n;
    }
    ac.putImageData(img, 0, 0);

    const cw = S / cols, ch = S / rows;
    const warm = ['#ffd9a0', '#ffc978', '#fff0cf', '#bfe0ff', '#9fd6ff', '#ffe9b8'];
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const px = x * cw + cw * 0.17, py = y * ch + ch * 0.14;
        const pw = cw * 0.66, ph = ch * 0.58;
        // 창틀
        ac.fillStyle = '#14161d';
        ac.fillRect(px - 2, py - 2, pw + 4, ph + 4);
        const lit = Math.random() < 0.42;
        if (lit) {
          const col = warm[(Math.random() * warm.length) | 0];
          ac.fillStyle = col; ac.fillRect(px, py, pw, ph);
          ec.fillStyle = col; ec.fillRect(px, py, pw, ph);
          // 실내 실루엣
          if (Math.random() < 0.35) {
            ac.fillStyle = 'rgba(0,0,0,.32)';
            const bw = pw * rr(0.2, 0.45);
            ac.fillRect(px + Math.random() * (pw - bw), py + ph * 0.35, bw, ph * 0.65);
          }
        } else {
          const g = ac.createLinearGradient(px, py, px + pw, py + ph);
          g.addColorStop(0, '#10141d'); g.addColorStop(1, '#1b2230');
          ac.fillStyle = g; ac.fillRect(px, py, pw, ph);
        }
        // 유리 반사 하이라이트
        ac.fillStyle = 'rgba(255,255,255,.06)';
        ac.fillRect(px, py, pw, ph * 0.22);
      }
    }
    // 층 구분선
    ac.fillStyle = 'rgba(0,0,0,.35)';
    for (let y = 0; y <= rows; y++) ac.fillRect(0, y * ch - 1, S, 3);
    return { albedo: mkTex(a), emissive: mkTex(e) };
  }

  function concreteTex(base, spec) {
    const S = 256, c = cvs(S, S), x = c.getContext('2d');
    x.fillStyle = base; x.fillRect(0, 0, S, S);
    const img = x.getImageData(0, 0, S, S), d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const n = (Math.random() - 0.5) * 34;
      d[i] += n; d[i + 1] += n; d[i + 2] += n;
    }
    x.putImageData(img, 0, 0);
    if (spec === 'asphalt') {
      x.strokeStyle = 'rgba(210,210,190,.5)'; x.lineWidth = 3;
      x.setLineDash([26, 26]);
      x.beginPath(); x.moveTo(S / 2, 0); x.lineTo(S / 2, S); x.stroke();
      x.setLineDash([]);
    } else if (spec === 'sidewalk') {
      x.strokeStyle = 'rgba(0,0,0,.28)'; x.lineWidth = 2;
      for (let i = 0; i <= 4; i++) {
        x.beginPath(); x.moveTo(i * S / 4, 0); x.lineTo(i * S / 4, S); x.stroke();
        x.beginPath(); x.moveTo(0, i * S / 4); x.lineTo(S, i * S / 4); x.stroke();
      }
    } else if (spec === 'roof') {
      for (let i = 0; i < 260; i++) {
        x.fillStyle = 'rgba(0,0,0,' + (Math.random() * 0.22) + ')';
        const s = Math.random() * 16 + 4;
        x.fillRect(Math.random() * S, Math.random() * S, s, s);
      }
    }
    return mkTex(c);
  }

  function neonTex() {
    const W = 256, H = 128, c = cvs(W, H), x = c.getContext('2d');
    x.fillStyle = '#000'; x.fillRect(0, 0, W, H);
    const words = ['웹', '零', 'NEO', '24', 'BAR', '寿司', 'デリ', 'OPEN', '龍', 'CITY'];
    x.fillStyle = '#fff';
    x.font = 'bold 74px sans-serif';
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText(words[(Math.random() * words.length) | 0], W / 2, H / 2);
    x.strokeStyle = '#fff'; x.lineWidth = 5;
    x.strokeRect(10, 10, W - 20, H - 20);
    return mkTex(c);
  }

  /* ------------------------------------------------------- 지오메트리 */
  function wallQuad(w, h, cx, cy, cz, rotY) {
    const g = new THREE.PlaneGeometry(w, h);
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, uv.getX(i) * (w / CFG.TILE), uv.getY(i) * (h / CFG.TILE));
    }
    g.rotateY(rotY);
    g.translate(cx, cy, cz);
    return g;
  }
  function roofQuad(w, d, cx, cy, cz) {
    const g = new THREE.PlaneGeometry(w, d);
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, uv.getX(i) * (w / CFG.ROOF_TILE), uv.getY(i) * (d / CFG.ROOF_TILE));
    }
    g.rotateX(-Math.PI / 2);
    g.translate(cx, cy, cz);
    return g;
  }
  function boxAt(w, h, d, x, y, z, ry) {
    const g = new THREE.BoxGeometry(w, h, d);
    if (ry) g.rotateY(ry);
    g.translate(x, y, z);
    return g;
  }

  /* --------------------------------------------------------- 공간 격자 */
  const CELL = 52;
  function key(cx, cz) { return cx + ',' + cz; }

  function makeIndex(boxes) {
    const map = new Map();
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      const x0 = Math.floor(b.x0 / CELL), x1 = Math.floor(b.x1 / CELL);
      const z0 = Math.floor(b.z0 / CELL), z1 = Math.floor(b.z1 / CELL);
      for (let cx = x0; cx <= x1; cx++) {
        for (let cz = z0; cz <= z1; cz++) {
          const k = key(cx, cz);
          let a = map.get(k);
          if (!a) { a = []; map.set(k, a); }
          a.push(i);
        }
      }
    }
    return map;
  }

  /* ------------------------------------------------------------- build */
  function build(scene, onProgress) {
    const boxes = [];        // 충돌용 AABB
    const wallGeo = [[], [], [], [], []];
    const roofGeo = [], concGeo = [], propGeo = [], neonGeo = [], sideGeo = [];
    const neonColors = [];
    const rooftops = [];     // 옥상 지점 (수집품 배치용)

    function addBuilding(cx, cz, w, d, hTotal, style) {
      let y = 0, cw = w, cd = d;
      const segs = hTotal > 90 ? ri(2, 3) : (hTotal > 50 ? ri(1, 2) : 1);
      const variant = ri(0, 4);
      for (let s = 0; s < segs; s++) {
        const frac = s === segs - 1 ? 1 : rr(0.42, 0.68);
        const remain = hTotal - y;
        const h = s === segs - 1 ? remain : remain * frac;
        if (h < 4) break;

        const hw = cw / 2, hd = cd / 2;
        const wg = wallGeo[variant];
        wg.push(wallQuad(cw, h, cx, y + h / 2, cz + hd, 0));
        wg.push(wallQuad(cw, h, cx, y + h / 2, cz - hd, Math.PI));
        wg.push(wallQuad(cd, h, cx + hw, y + h / 2, cz, Math.PI / 2));
        wg.push(wallQuad(cd, h, cx - hw, y + h / 2, cz, -Math.PI / 2));
        roofGeo.push(roofQuad(cw, cd, cx, y + h + 0.06, cz));
        // 옥상 난간(테두리만) / 층 처마
        const RW = 0.8, RH = 1.0, ry = y + h + RH / 2;
        concGeo.push(boxAt(cw + RW * 2, RH, RW, cx, ry, cz + hd + RW / 2));
        concGeo.push(boxAt(cw + RW * 2, RH, RW, cx, ry, cz - hd - RW / 2));
        concGeo.push(boxAt(RW, RH, cd, cx + hw + RW / 2, ry, cz));
        concGeo.push(boxAt(RW, RH, cd, cx - hw - RW / 2, ry, cz));
        if (s > 0) concGeo.push(boxAt(cw + 1.6, 0.5, cd + 1.6, cx, y + 0.25, cz));

        boxes.push({ x0: cx - hw, x1: cx + hw, y0: 0, y1: y + h + 0.06, z0: cz - hd, z1: cz + hd });

        // 네온 간판
        if (rnd() < 0.16 && h > 14) {
          const side = ri(0, 3);
          const sw = Math.min(cw, cd) * rr(0.35, 0.6), sh = sw * 0.5;
          const yy = y + rr(h * 0.25, h * 0.8);
          const off = 0.35;
          let g;
          if (side === 0) g = wallQuad(sw, sh, cx, yy, cz + hd + off, 0);
          else if (side === 1) g = wallQuad(sw, sh, cx, yy, cz - hd - off, Math.PI);
          else if (side === 2) g = wallQuad(sw, sh, cx + hw + off, yy, cz, Math.PI / 2);
          else g = wallQuad(sw, sh, cx - hw - off, yy, cz, -Math.PI / 2);
          const uv = g.attributes.uv;   // 네온은 1회만 반복
          for (let i = 0; i < uv.count; i++) uv.setXY(i, i % 2, i < 2 ? 1 : 0);
          g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 1, 1, 1, 0, 0, 1, 0]), 2));
          const col = new THREE.Color().setHSL(rnd(), 0.9, 0.62);
          const cnt = g.attributes.position.count;
          const arr = new Float32Array(cnt * 3);
          for (let i = 0; i < cnt; i++) { arr[i * 3] = col.r; arr[i * 3 + 1] = col.g; arr[i * 3 + 2] = col.b; }
          g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
          neonGeo.push(g);
        }

        y += h;
        cw *= rr(0.72, 0.86); cd *= rr(0.72, 0.86);
      }

      rooftops.push({ x: cx, y: y + 1.3, z: cz, w: cw, d: cd });

      // 옥상 설비
      const n = ri(1, 3);
      for (let i = 0; i < n; i++) {
        const bw = rr(2, 5), bd = rr(2, 5), bh = rr(1.2, 3);
        propGeo.push(boxAt(bw, bh, bd, cx + rr(-cw / 3, cw / 3), y + 1.1 + bh / 2, cz + rr(-cd / 3, cd / 3)));
      }
      if (rnd() < 0.35 && cw > 10) {   // 물탱크
        const px = cx + rr(-cw / 4, cw / 4), pz = cz + rr(-cd / 4, cd / 4);
        const tank = new THREE.CylinderGeometry(2.1, 2.1, 4, 12);
        tank.translate(px, y + 5.4, pz);
        propGeo.push(tank);
        const cone = new THREE.ConeGeometry(2.4, 1.5, 12);
        cone.translate(px, y + 8.1, pz);
        propGeo.push(cone);
        for (let l = 0; l < 4; l++) {
          const a = l / 4 * Math.PI * 2 + 0.6;
          propGeo.push(boxAt(0.28, 3.4, 0.28, px + Math.cos(a) * 1.7, y + 2.6, pz + Math.sin(a) * 1.7));
        }
      }
      if (style === 'spire') {
        const m = new THREE.CylinderGeometry(0.35, 1.6, 26, 10);
        m.translate(cx, y + 14, cz);
        propGeo.push(m);
      }
    }

    /* --- 블록 배치 --- */
    const O = -HALF + PITCH / 2;
    for (let gx = 0; gx < CFG.GRID; gx++) {
      for (let gz = 0; gz < CFG.GRID; gz++) {
        const bx = O + gx * PITCH, bz = O + gz * PITCH;
        const distC = Math.hypot(bx, bz) / HALF;

        // 사각형 인도
        const sg = new THREE.PlaneGeometry(CFG.BLOCK + 8, CFG.BLOCK + 8);
        const uv = sg.attributes.uv;
        for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 7, uv.getY(i) * 7);
        sg.rotateX(-Math.PI / 2); sg.translate(bx, 0.04, bz);
        sideGeo.push(sg);

        if (rnd() < 0.055) continue;   // 공원/공터

        // 블록을 1~4 로트로 분할
        const lots = [];
        const split = rnd();
        if (split < 0.3) lots.push([bx, bz, CFG.BLOCK, CFG.BLOCK]);
        else if (split < 0.62) {
          const f = rr(0.4, 0.6);
          lots.push([bx, bz - CFG.BLOCK * (0.5 - f / 2), CFG.BLOCK, CFG.BLOCK * f]);
          lots.push([bx, bz + CFG.BLOCK * f / 2, CFG.BLOCK, CFG.BLOCK * (1 - f)]);
        } else {
          const fx = rr(0.4, 0.6), fz = rr(0.4, 0.6);
          lots.push([bx - CFG.BLOCK * (0.5 - fx / 2), bz - CFG.BLOCK * (0.5 - fz / 2), CFG.BLOCK * fx, CFG.BLOCK * fz]);
          lots.push([bx + CFG.BLOCK * fx / 2, bz - CFG.BLOCK * (0.5 - fz / 2), CFG.BLOCK * (1 - fx), CFG.BLOCK * fz]);
          lots.push([bx - CFG.BLOCK * (0.5 - fx / 2), bz + CFG.BLOCK * fz / 2, CFG.BLOCK * fx, CFG.BLOCK * (1 - fz)]);
          lots.push([bx + CFG.BLOCK * fx / 2, bz + CFG.BLOCK * fz / 2, CFG.BLOCK * (1 - fx), CFG.BLOCK * (1 - fz)]);
        }

        lots.forEach(L => {
          const w = L[2] - rr(5, 10), d = L[3] - rr(5, 10);
          if (w < 12 || d < 12) return;
          const tall = Math.max(0, 1 - distC);
          let h = rr(22, 46) + Math.pow(tall, 1.7) * rr(70, 190);
          let style = null;
          if (rnd() < 0.03 && distC < 0.5) { h *= 1.55; style = 'spire'; }
          addBuilding(L[0], L[1], w, d, h, style);
        });
      }
    }
    if (onProgress) onProgress(0.45, '빌딩 배치 완료');

    /* --- 머지 & 씬 추가 --- */
    const meshes = [];
    for (let v = 0; v < wallGeo.length; v++) {
      if (!wallGeo[v].length) continue;
      const tiles = windowTiles(v);
      const mat = new THREE.MeshStandardMaterial({
        map: tiles.albedo, emissiveMap: tiles.emissive,
        emissive: new THREE.Color(0xffffff), emissiveIntensity: 1.35,
        roughness: 0.72, metalness: 0.1
      });
      const g = BGU.mergeBufferGeometries(wallGeo[v], false);
      const m = new THREE.Mesh(g, mat);
      m.castShadow = true; m.receiveShadow = true;
      scene.add(m); meshes.push(m);
    }
    {
      const g = BGU.mergeBufferGeometries(roofGeo, false);
      const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({
        map: concreteTex('#2b2d34', 'roof'), roughness: 0.95, metalness: 0.02
      }));
      m.receiveShadow = true; scene.add(m); meshes.push(m);
    }
    {
      const g = BGU.mergeBufferGeometries(concGeo, false);
      const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({
        color: 0x373a43, roughness: 0.9, metalness: 0.05
      }));
      m.castShadow = true; m.receiveShadow = true; scene.add(m); meshes.push(m);
    }
    {
      const g = BGU.mergeBufferGeometries(propGeo, false);
      const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({
        color: 0x565a63, roughness: 0.8, metalness: 0.35
      }));
      m.castShadow = true; m.receiveShadow = true; scene.add(m); meshes.push(m);
    }
    {
      const g = BGU.mergeBufferGeometries(sideGeo, false);
      const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({
        map: concreteTex('#4b4d55', 'sidewalk'), roughness: 0.95, metalness: 0
      }));
      m.receiveShadow = true; scene.add(m); meshes.push(m);
    }
    if (neonGeo.length) {
      const g = BGU.mergeBufferGeometries(neonGeo, false);
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
        map: neonTex(), vertexColors: true, transparent: true, opacity: 0.95,
        toneMapped: false, side: THREE.DoubleSide
      }));
      scene.add(m); meshes.push(m);
    }
    if (onProgress) onProgress(0.62, '텍스처 굽는 중');

    /* --- 도로 --- */
    const road = new THREE.Mesh(
      new THREE.PlaneGeometry(HALF * 2.6, HALF * 2.6),
      new THREE.MeshStandardMaterial({
        map: concreteTex('#212329', 'asphalt'), roughness: 0.86, metalness: 0.06
      })
    );
    road.material.map.repeat.set(120, 120);
    road.rotation.x = -Math.PI / 2;
    road.receiveShadow = true;
    scene.add(road);

    /* --- 가로등 --- */
    {
      const poles = [], bulbs = [];
      for (let gx = 0; gx <= CFG.GRID; gx++) {
        for (let gz = 0; gz < CFG.GRID * CFG.LAMP_DENSITY; gz++) {
          const x = -HALF + gx * PITCH;
          const z = -HALF + (gz + 0.5) * (PITCH / CFG.LAMP_DENSITY);
          [[x - 9, z], [x + 9, z]].forEach(p => {
            poles.push(boxAt(0.28, 8, 0.28, p[0], 4, p[1]));
            const arm = boxAt(2.2, 0.22, 0.22, p[0] + (p[0] > x ? -1.1 : 1.1), 7.9, p[1]);
            poles.push(arm);
            const b = new THREE.SphereGeometry(0.42, 8, 6);
            b.translate(p[0] + (p[0] > x ? -2.1 : 2.1), 7.75, p[1]);
            bulbs.push(b);
          });
          // 교차 방향
          const z2 = -HALF + gx * PITCH;
          const x2 = -HALF + (gz + 0.5) * (PITCH / CFG.LAMP_DENSITY);
          poles.push(boxAt(0.28, 8, 0.28, x2, 4, z2 - 9));
          const b2 = new THREE.SphereGeometry(0.42, 8, 6);
          b2.translate(x2, 7.75, z2 - 9 + 1.1);
          bulbs.push(b2);
        }
      }
      const pg = BGU.mergeBufferGeometries(poles, false);
      const pm = new THREE.Mesh(pg, new THREE.MeshStandardMaterial({ color: 0x2c2f38, roughness: 0.7, metalness: 0.6 }));
      scene.add(pm); meshes.push(pm);
      const bg = BGU.mergeBufferGeometries(bulbs, false);
      const bm = new THREE.Mesh(bg, new THREE.MeshBasicMaterial({ color: 0xffd9a0, toneMapped: false }));
      scene.add(bm); meshes.push(bm);
    }
    if (onProgress) onProgress(0.74, '가로등 점등');

    /* --- 자동차 --- */
    const cars = makeCars(scene);

    /* --- 수집품 --- */
    const tokens = makeTokens(scene, rooftops);
    const rings = makeRings(scene, rooftops);

    /* --- 하늘 / 조명 --- */
    const sky = makeSky(scene);
    const sun = new THREE.DirectionalLight(0xffc49a, 1.05);
    sun.position.set(60, 90, -40);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const SH = 90;
    sun.shadow.camera.left = -SH; sun.shadow.camera.right = SH;
    sun.shadow.camera.top = SH; sun.shadow.camera.bottom = -SH;
    sun.shadow.camera.near = 1; sun.shadow.camera.far = 420;
    sun.shadow.bias = -0.0012;
    sun.shadow.normalBias = 0.05;
    scene.add(sun);
    scene.add(sun.target);

    scene.add(new THREE.HemisphereLight(0x4b6ea8, 0x14171f, 0.62));
    scene.add(new THREE.AmbientLight(0x28304a, 0.55));

    scene.fog = new THREE.FogExp2(0x141a2b, 0.0019);

    if (onProgress) onProgress(0.9, '충돌 격자 구축');
    const index = makeIndex(boxes);

    const city = {
      boxes, index, meshes, cars, tokens, rings, sun, sky,
      HALF, PITCH, CELL,
      mapCanvas: makeMapCanvas(boxes),
      update: function (dt, t, playerPos) {
        cars.update(dt);
        tokens.update(dt, t);
        rings.update(dt, t);
        // 그림자 카메라를 플레이어 근처로
        const d = 120;
        sun.position.set(playerPos.x + 70, playerPos.y + 110, playerPos.z - 55);
        sun.target.position.copy(playerPos);
        sun.target.updateMatrixWorld();
        sky.position.set(playerPos.x, 0, playerPos.z);
      }
    };
    NS.cityRef = city;
    return city;
  }

  /* ------------------------------------------------------------- 차량 */
  function makeCars(scene) {
    const N = CFG.CARS;
    const body = boxAt(1.9, 0.72, 4.3, 0, 0.62, 0);
    const cab = boxAt(1.7, 0.62, 2.1, 0, 1.24, -0.2);
    const geo = BGU.mergeBufferGeometries([body, cab], false);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.65 });
    const mesh = new THREE.InstancedMesh(geo, mat, N);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.castShadow = true;
    scene.add(mesh);

    // 헤드/테일 라이트
    const lg = [];
    const cols = [];
    function lamp(x, y, z, c) {
      const g = new THREE.SphereGeometry(0.19, 6, 5);
      g.translate(x, y, z);
      const n = g.attributes.position.count;
      const arr = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { arr[i * 3] = c[0]; arr[i * 3 + 1] = c[1]; arr[i * 3 + 2] = c[2]; }
      g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
      lg.push(g);
    }
    lamp(-0.62, 0.62, 2.2, [1, 0.95, 0.8]); lamp(0.62, 0.62, 2.2, [1, 0.95, 0.8]);
    lamp(-0.62, 0.68, -2.2, [1, 0.1, 0.08]); lamp(0.62, 0.68, -2.2, [1, 0.1, 0.08]);
    const lightMesh = new THREE.InstancedMesh(
      BGU.mergeBufferGeometries(lg, false),
      new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }), N);
    lightMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(lightMesh);

    const cars = [];
    const carCols = [0xdddddd, 0x1a1a22, 0x8b1220, 0x14304f, 0xd8b021, 0x2c6e49, 0x555a66];
    const dummy = new THREE.Object3D();
    const col = new THREE.Color();
    for (let i = 0; i < N; i++) {
      const axis = i % 2;
      const lane = Math.floor(rr(0, CFG.GRID + 1));
      const dir = rnd() < 0.5 ? 1 : -1;
      const off = (dir > 0 ? 5.5 : -5.5);
      cars.push({
        axis, dir,
        cross: -HALF + lane * PITCH + off,
        along: rr(-HALF, HALF),
        speed: rr(11, 22)
      });
      col.setHex(carCols[i % carCols.length]);
      mesh.setColorAt(i, col);
    }
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

    return {
      mesh, lightMesh, list: cars,
      update: function (dt) {
        for (let i = 0; i < cars.length; i++) {
          const c = cars[i];
          c.along += c.speed * c.dir * dt;
          if (c.along > HALF) c.along = -HALF;
          if (c.along < -HALF) c.along = HALF;
          if (c.axis === 0) {
            dummy.position.set(c.cross, 0, c.along);
            dummy.rotation.set(0, c.dir > 0 ? 0 : Math.PI, 0);
          } else {
            dummy.position.set(c.along, 0, c.cross);
            dummy.rotation.set(0, c.dir > 0 ? Math.PI / 2 : -Math.PI / 2, 0);
          }
          dummy.updateMatrix();
          mesh.setMatrixAt(i, dummy.matrix);
          lightMesh.setMatrixAt(i, dummy.matrix);
        }
        mesh.instanceMatrix.needsUpdate = true;
        lightMesh.instanceMatrix.needsUpdate = true;
      }
    };
  }

  /* ---------------------------------------------------------- 수집품 */
  function makeTokens(scene, rooftops) {
    const N = CFG.TOKENS;
    if (N <= 0) return { mesh: null, list: [], update: function () { } };
    const g1 = new THREE.TorusGeometry(1.1, 0.16, 10, 26);
    const g2 = new THREE.SphereGeometry(0.42, 12, 10);
    const geo = BGU.mergeBufferGeometries([g1, g2], false);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xff2b3c, emissive: 0xff2b3c, emissiveIntensity: 2.2,
      roughness: 0.3, metalness: 0.4, toneMapped: true
    });
    const mesh = new THREE.InstancedMesh(geo, mat, N);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(mesh);

    const list = [];
    for (let i = 0; i < N; i++) {
      const r = rooftops[Math.floor(rnd() * rooftops.length)];
      if (!r) break;
      list.push({
        pos: new V3(r.x + rr(-6, 6), r.y + rr(3, 22), r.z + rr(-6, 6)),
        alive: true, t: rnd() * 6
      });
    }
    const dummy = new THREE.Object3D();
    return {
      mesh, list,
      update: function (dt, time) {
        for (let i = 0; i < list.length; i++) {
          const o = list[i];
          if (!o.alive) { dummy.scale.setScalar(0.0001); dummy.position.copy(o.pos); }
          else {
            dummy.position.copy(o.pos);
            dummy.position.y += Math.sin(time * 1.6 + o.t) * 0.45;
            dummy.scale.setScalar(1);
          }
          dummy.rotation.set(0, time * 1.5 + o.t, 0.35);
          dummy.updateMatrix();
          mesh.setMatrixAt(i, dummy.matrix);
        }
        mesh.instanceMatrix.needsUpdate = true;
      }
    };
  }

  function makeRings(scene, rooftops) {
    const N = CFG.RINGS;
    if (N <= 0) return { mesh: null, list: [], update: function () { } };
    const geo = new THREE.TorusGeometry(4.4, 0.32, 10, 40);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x4fe6ff, emissive: 0x2fd0ff, emissiveIntensity: 2.4,
      roughness: 0.25, metalness: 0.2, transparent: true, opacity: 0.92
    });
    const mesh = new THREE.InstancedMesh(geo, mat, N);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(mesh);

    const list = [];
    let a = rnd() * 6.28;
    let px = 0, pz = 0;
    for (let i = 0; i < N; i++) {
      a += rr(-0.5, 0.5);
      px += Math.cos(a) * rr(60, 105);
      pz += Math.sin(a) * rr(60, 105);
      px = Math.max(-HALF + 30, Math.min(HALF - 30, px));
      pz = Math.max(-HALF + 30, Math.min(HALF - 30, pz));
      list.push({
        pos: new V3(px, rr(28, 80), pz),
        rotY: a + Math.PI / 2, alive: true, t: rnd() * 6
      });
    }
    const dummy = new THREE.Object3D();
    return {
      mesh, list,
      update: function (dt, time) {
        for (let i = 0; i < list.length; i++) {
          const o = list[i];
          dummy.position.copy(o.pos);
          dummy.rotation.set(0, o.rotY, 0);
          dummy.scale.setScalar(o.alive ? 1 + Math.sin(time * 2 + o.t) * 0.04 : 0.0001);
          dummy.updateMatrix();
          mesh.setMatrixAt(i, dummy.matrix);
        }
        mesh.instanceMatrix.needsUpdate = true;
      }
    };
  }

  /* ------------------------------------------------------------- 하늘 */
  function makeSky(scene) {
    const geo = new THREE.SphereGeometry(2600, 32, 20);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { uSun: { value: new V3(0.55, 0.30, -0.45).normalize() } },
      vertexShader: `
        varying vec3 vD;
        void main(){ vD = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `
        varying vec3 vD;
        uniform vec3 uSun;
        float hash(vec3 p){ p = fract(p*0.3183099+vec3(0.71,0.113,0.419));
          p *= 17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
        void main(){
          float h = clamp(vD.y*0.5+0.5, 0.0, 1.0);
          vec3 zen  = vec3(0.035,0.055,0.135);
          vec3 mid  = vec3(0.115,0.135,0.265);
          vec3 hor  = vec3(0.42,0.30,0.36);
          vec3 col = mix(hor, mid, smoothstep(0.48,0.62,h));
          col = mix(col, zen, smoothstep(0.6,0.95,h));
          // 석양 글로우
          float s = max(dot(vD, uSun), 0.0);
          col += vec3(1.0,0.45,0.18) * pow(s, 7.0) * 0.75;
          col += vec3(1.0,0.62,0.32) * pow(s, 2.0) * 0.10;
          // 별
          if (vD.y > 0.06) {
            vec3 g = floor(vD*340.0);
            float n = hash(g);
            float st = smoothstep(0.9975, 1.0, n) * smoothstep(0.06,0.55,vD.y);
            col += vec3(st)*1.4;
          }
          gl_FragColor = vec4(col, 1.0);
        }`
    });
    const m = new THREE.Mesh(geo, mat);
    m.frustumCulled = false;
    scene.add(m);

    // 달
    const moon = new THREE.Mesh(
      new THREE.SphereGeometry(46, 20, 16),
      new THREE.MeshBasicMaterial({ color: 0xfff3d8, toneMapped: false })
    );
    moon.position.set(-900, 720, 1500);
    m.add(moon);
    return m;
  }

  /* -------------------------------------------------------- 미니맵 이미지 */
  function makeMapCanvas(boxes) {
    const S = 512, c = cvs(S, S), x = c.getContext('2d');
    x.fillStyle = '#0b0d14'; x.fillRect(0, 0, S, S);
    const sc = S / (HALF * 2);
    x.fillStyle = '#20263a';
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      const h = Math.min(1, b.y1 / 200);
      x.fillStyle = 'rgb(' + (32 + h * 70 | 0) + ',' + (38 + h * 76 | 0) + ',' + (58 + h * 92 | 0) + ')';
      x.fillRect((b.x0 + HALF) * sc, (b.z0 + HALF) * sc, (b.x1 - b.x0) * sc, (b.z1 - b.z0) * sc);
    }
    return c;
  }

  /* ---------------------------------------------------- 충돌 / 레이캐스트 */
  function nearBoxes(city, x, z, r, out) {
    out.length = 0;
    const cx0 = Math.floor((x - r) / CELL), cx1 = Math.floor((x + r) / CELL);
    const cz0 = Math.floor((z - r) / CELL), cz1 = Math.floor((z + r) / CELL);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        const a = city.index.get(key(cx, cz));
        if (!a) continue;
        for (let i = 0; i < a.length; i++) if (out.indexOf(a[i]) < 0) out.push(a[i]);
      }
    }
    return out;
  }

  const _tmpIdx = [];
  function raycast(city, ox, oy, oz, dx, dy, dz, maxD, hit) {
    let best = maxD, found = false;
    const step = CELL * 0.75;
    const seen = new Set();
    for (let travel = 0; travel <= maxD; travel += step) {
      const px = ox + dx * travel, pz = oz + dz * travel;
      const cx = Math.floor(px / CELL), cz = Math.floor(pz / CELL);
      for (let ax = -1; ax <= 1; ax++) {
        for (let az = -1; az <= 1; az++) {
          const arr = city.index.get(key(cx + ax, cz + az));
          if (!arr) continue;
          for (let i = 0; i < arr.length; i++) {
            const id = arr[i];
            if (seen.has(id)) continue;
            seen.add(id);
            const b = city.boxes[id];
            // slab
            let tmin = 0, tmax = best, axis = -1, sign = 1;
            let t0, t1;
            // X
            if (Math.abs(dx) < 1e-8) { if (ox < b.x0 || ox > b.x1) continue; }
            else {
              t0 = (b.x0 - ox) / dx; t1 = (b.x1 - ox) / dx;
              let s = -1; if (t0 > t1) { const tt = t0; t0 = t1; t1 = tt; s = 1; }
              if (t0 > tmin) { tmin = t0; axis = 0; sign = s; }
              if (t1 < tmax) tmax = t1;
              if (tmin > tmax) continue;
            }
            // Y
            if (Math.abs(dy) < 1e-8) { if (oy < b.y0 || oy > b.y1) continue; }
            else {
              t0 = (b.y0 - oy) / dy; t1 = (b.y1 - oy) / dy;
              let s = -1; if (t0 > t1) { const tt = t0; t0 = t1; t1 = tt; s = 1; }
              if (t0 > tmin) { tmin = t0; axis = 1; sign = s; }
              if (t1 < tmax) tmax = t1;
              if (tmin > tmax) continue;
            }
            // Z
            if (Math.abs(dz) < 1e-8) { if (oz < b.z0 || oz > b.z1) continue; }
            else {
              t0 = (b.z0 - oz) / dz; t1 = (b.z1 - oz) / dz;
              let s = -1; if (t0 > t1) { const tt = t0; t0 = t1; t1 = tt; s = 1; }
              if (t0 > tmin) { tmin = t0; axis = 2; sign = s; }
              if (t1 < tmax) tmax = t1;
              if (tmin > tmax) continue;
            }
            if (tmin > 0.001 && tmin < best) {
              best = tmin; found = true;
              hit.dist = tmin;
              hit.x = ox + dx * tmin; hit.y = oy + dy * tmin; hit.z = oz + dz * tmin;
              hit.nx = axis === 0 ? sign : 0;
              hit.ny = axis === 1 ? sign : 0;
              hit.nz = axis === 2 ? sign : 0;
              hit.box = b;
            }
          }
        }
      }
      if (found && best < travel) break;
    }
    // 지면
    if (dy < -1e-6) {
      const tg = -oy / dy;
      if (tg > 0.001 && tg < best) {
        best = tg; found = true;
        hit.dist = tg;
        hit.x = ox + dx * tg; hit.y = 0; hit.z = oz + dz * tg;
        hit.nx = 0; hit.ny = 1; hit.nz = 0; hit.box = null;
      }
    }
    return found;
  }

  NS.City = {
    build, nearBoxes, raycast, configure, CFG, CELL,
    get PITCH() { return PITCH; },
    get HALF() { return HALF; }
  };
})();
