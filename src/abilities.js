/* =========================================================================
   abilities.js — 슈트 8종 고유 능력 + 포커스 게이지
   · 게이지가 가득 차야(1.0) 발동. 발동하면 0 으로 소모된다.
   · 지속형 능력은 ctrl.mods 를 바꾸고, 끝나면 반드시 기본값으로 되돌린다.
   · 이펙트는 create() 에서 전부 만들어 두고 visible/scale/opacity 만 갱신한다.
     (매 프레임 new Geometry / Material / Vector3 금지)
   ========================================================================= */
(function () {
  const NS = (window.SPIDER = window.SPIDER || {});
  const V3 = THREE.Vector3;

  /* ------------------------------------------------------------ 게이지 */
  const CHARGE = 0.05;        // 초당 기본 충전량
  const FAST_KMH = 130;       // 이 속도 이상이면 가속 충전
  const FAST_MUL = 1.6;
  const SWING_MUL = 1.35;
  const ARREST_GAIN = 0.25;   // 체포 1회

  /* ------------------------------------------------------------ 능력표 */
  /* dur: 지속 초 (0 이면 즉발) / fx: 즉발형 이펙트 재생 시간 */
  const DEF = {
    classic: {
      name: '웹 블라썸', desc: '반경 18m 안의 모든 범인에게 거미줄을 난사한다',
      color: '#ff5a6e', dur: 0, fx: 0.65, tint: null
    },
    advanced: {
      name: '배틀 포커스', desc: '5초간 세상이 느려진다 (시간 0.4배)',
      color: '#4fe6ff', dur: 5, fx: 0, tint: '#4fe6ff'
    },
    symbiote: {
      name: '심비오트 광란', desc: '8초간 이동 1.45배 · 타격 2배 · 낙하 감속',
      color: '#a24cff', dur: 8, fx: 0, tint: '#5a1f8c'
    },
    iron: {
      name: '나노 부스터', desc: '6초간 이동 1.5배 · 타격 1.5배 · 나노 파편 전개',
      color: '#ffc24a', dur: 6, fx: 0, tint: '#ffb020'
    },
    miles: {
      name: '베놈 블래스트', desc: '반경 22m 전기 충격파 — 범위 안 범인 즉시 제압',
      color: '#4fd8ff', dur: 0, fx: 0.95, tint: null
    },
    noir: {
      name: '느와르 스텔스', desc: '7초간 반투명 잠행 · 이동 1.2배',
      color: '#8fb6d8', dur: 7, fx: 0, tint: '#111a2a'
    },
    s2099: {
      name: '가속 대시', desc: '바라보는 방향으로 순간 가속',
      color: '#ff3348', dur: 0, fx: 0.6, tint: null
    },
    gwen: {
      name: '스파이더 그레이스', desc: '9초간 웹윙 활공 · 낙하 0.3배',
      color: '#ff8fd0', dur: 9, fx: 0, tint: '#ffd7ee'
    }
  };

  /* --------------------------------------------------------- 공용 버퍼 */
  const _v = new V3(), _dir = new V3();
  const _scratch = [];        // 적 임시 목록 (재사용)
  const _hit = [];            // 명중 표시 (재사용 — 매 발동마다 new Array 금지)

  /* 유한값 가드 —— NaN 이 player.vel / Object3D.matrix 로 한 번이라도 새면
     그 프레임부터 카메라·컬링·도시가 전부 NaN 이 된다. 경계에서 전부 막는다. */
  const isNum = (typeof Number.isFinite === 'function')
    ? Number.isFinite
    : function (v) { return typeof v === 'number' && isFinite(v); };
  function fin(v, d) { return isNum(v) ? v : d; }
  function vecFin(v) { return !!v && isNum(v.x) && isNum(v.y) && isNum(v.z); }
  function normId(id) { return (id && DEF[id]) ? id : 'classic'; }

  /* ---------------------------------------------------- 이펙트 지오메트리 */
  /* 방사형 거미줄 다발: n 갈래 리본을 하나의 지오메트리로 (반지름 1 기준) */
  function radialGeo(n, spread) {
    const pos = new Float32Array(n * 4 * 3);
    const idx = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const el = Math.sin(i * 2.399) * (spread || 0.34);   // 결정적 상하 분산
      const ce = Math.cos(el);
      const dx = Math.cos(a) * ce, dy = Math.sin(el), dz = Math.sin(a) * ce;
      const ux = -Math.sin(a), uz = Math.cos(a);           // 폭 방향(수평)
      const r0 = 0.1, r1 = 1.0, w0 = 0.05, w1 = 0.014;
      const b = i * 12;
      pos[b] = dx * r0 + ux * w0; pos[b + 1] = dy * r0; pos[b + 2] = dz * r0 + uz * w0;
      pos[b + 3] = dx * r0 - ux * w0; pos[b + 4] = dy * r0; pos[b + 5] = dz * r0 - uz * w0;
      pos[b + 6] = dx * r1 + ux * w1; pos[b + 7] = dy * r1; pos[b + 8] = dz * r1 + uz * w1;
      pos[b + 9] = dx * r1 - ux * w1; pos[b + 10] = dy * r1; pos[b + 11] = dz * r1 - uz * w1;
      const o = i * 4;
      idx.push(o, o + 2, o + 1, o + 1, o + 2, o + 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.boundingSphere = new THREE.Sphere(new V3(), 1.05);
    return g;
  }

  /* 그웬 웹윙: 겨드랑이~허리를 잇는 삼각 평면 (side +1 = 왼쪽) */
  function wingGeo(side) {
    const g = new THREE.BufferGeometry();
    const p = new Float32Array([
      side * 0.17, 0.25, -0.03,     // 어깨
      side * 0.14, -0.62, -0.06,    // 허리 아래
      side * 0.78, -0.16, -0.14     // 바깥 끝
    ]);
    const uv = new Float32Array([0.5, 1, 0.5, 0, 1, 0.5]);
    g.setAttribute('position', new THREE.BufferAttribute(p, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.computeVertexNormals();
    return g;
  }

  /* 웹 무늬 캔버스 (투명 배경 — 외부 이미지 없이 절차 생성) */
  function webCanvas() {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const x = c.getContext('2d');
    x.clearRect(0, 0, 256, 256);
    if (NS.Suits && NS.Suits._drawWebNet) {
      NS.Suits._drawWebNet(x, 128, 128, 190, {
        color: '#ffffff', alpha: 0.9, lw: 2.2, spokes: 14, rings: 9
      });
    } else {
      x.strokeStyle = 'rgba(255,255,255,0.9)';
      x.lineWidth = 2;
      for (let i = 0; i < 14; i++) {
        const a = (i / 14) * Math.PI * 2;
        x.beginPath(); x.moveTo(128, 128);
        x.lineTo(128 + Math.cos(a) * 190, 128 + Math.sin(a) * 190); x.stroke();
      }
    }
    const t = new THREE.CanvasTexture(c);
    return t;
  }

  /* ========================================================== 컨트롤러 */
  function create(scene, player, crime) {
    /* ---------------------------------------------- 이펙트 사전 생성 */
    const followFx = new THREE.Group();   // 플레이어를 따라다니는 것
    scene.add(followFx);
    const worldFx = new THREE.Group();    // 발동 지점에 고정되는 것
    scene.add(worldFx);

    /* 1) 방사형 거미줄 (웹 블라썸) */
    const blossomMat = new THREE.MeshBasicMaterial({
      color: 0xf2f5ff, transparent: true, opacity: 0, side: THREE.DoubleSide,
      depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false
    });
    const blossom = new THREE.Mesh(radialGeo(18, 0.36), blossomMat);
    blossom.frustumCulled = false;
    blossom.visible = false;
    blossom.position.y = 1.1;             // 허리 높이에서 퍼진다
    worldFx.add(blossom);

    /* 2) 확장 링 3겹 (베놈 블래스트 / 웹 블라썸 공용) */
    const ringGeo = new THREE.RingGeometry(0.9, 1.0, 44);
    ringGeo.rotateX(-Math.PI / 2);
    const rings = [];
    for (let i = 0; i < 3; i++) {
      const m = new THREE.MeshBasicMaterial({
        color: 0x4fd8ff, transparent: true, opacity: 0, side: THREE.DoubleSide,
        depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false
      });
      const mesh = new THREE.Mesh(ringGeo, m);
      mesh.frustumCulled = false;
      mesh.visible = false;
      worldFx.add(mesh);
      rings.push({ mesh: mesh, mat: m, delay: i * 0.12 });
    }

    /* 3) 번개 6가닥 (베놈 블래스트) */
    const BOLTS = 6, BSEG = 6;
    const boltPos = new Float32Array(BOLTS * BSEG * 2 * 3);
    const boltGeo = new THREE.BufferGeometry();
    boltGeo.setAttribute('position', new THREE.BufferAttribute(boltPos, 3));
    const boltMat = new THREE.LineBasicMaterial({
      color: 0x9fe8ff, transparent: true, opacity: 0,
      depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false
    });
    const bolts = new THREE.LineSegments(boltGeo, boltMat);
    bolts.frustumCulled = false;
    bolts.visible = false;
    worldFx.add(bolts);

    function makeBolts(radius) {
      let k = 0;
      for (let b = 0; b < BOLTS; b++) {
        const a = (b / BOLTS) * Math.PI * 2 + Math.random() * 0.4;
        const el = (Math.random() - 0.35) * 0.5;
        let px = 0, py = 1.0, pz = 0;
        for (let s = 1; s <= BSEG; s++) {
          const r = (s / BSEG) * radius;
          const ja = a + (Math.random() - 0.5) * 0.55;
          const nx = Math.cos(ja) * r * Math.cos(el);
          const ny = 1.0 + Math.sin(el) * r * 0.5 + (Math.random() - 0.5) * 1.6;
          const nz = Math.sin(ja) * r * Math.cos(el);
          boltPos[k++] = px; boltPos[k++] = py; boltPos[k++] = pz;
          boltPos[k++] = nx; boltPos[k++] = ny; boltPos[k++] = nz;
          px = nx; py = ny; pz = nz;
        }
      }
      boltGeo.attributes.position.needsUpdate = true;
    }

    /* 4) 붉은 잔상 3개 (가속 대시) */
    const ghostGeo = (NS.Character && NS.Character.capsuleGeom)
      ? NS.Character.capsuleGeom(0.22, 0.28, 0.85, 10)
      : new THREE.SphereGeometry(0.4, 10, 8);
    const ghosts = [];
    for (let i = 0; i < 3; i++) {
      const m = new THREE.MeshBasicMaterial({
        color: 0xff3348, transparent: true, opacity: 0,
        depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false
      });
      const mesh = new THREE.Mesh(ghostGeo, m);
      mesh.visible = false;
      mesh.frustumCulled = false;
      scene.add(mesh);
      ghosts.push({ mesh: mesh, mat: m });
    }

    /* 5) 검은 촉수 6가닥 (심비오트) */
    const tentGeo = new THREE.CylinderGeometry(0.018, 0.075, 1.15, 6, 1, true);
    tentGeo.translate(0, 0.575, 0);       // 피벗을 아래쪽 끝으로
    const tentMat = new THREE.MeshStandardMaterial({
      color: 0x0a0a12, roughness: 0.3, metalness: 0.25,
      emissive: 0x3a0d55, emissiveIntensity: 0.55, side: THREE.DoubleSide
    });
    const tentacles = [];
    for (let i = 0; i < 6; i++) {
      const pivot = new THREE.Object3D();
      const a = (i / 6) * Math.PI * 2;
      pivot.position.set(Math.cos(a) * 0.16, 1.05, Math.sin(a) * 0.12);
      const mesh = new THREE.Mesh(tentGeo, tentMat);
      pivot.add(mesh);
      pivot.visible = false;
      followFx.add(pivot);
      tentacles.push({ pivot: pivot, phase: i * 1.05, ang: a });
    }

    /* 6) 금색 나노 파편 궤도 (아이언) */
    const shardGeo = new THREE.OctahedronGeometry(0.085, 0);
    const shardMat = new THREE.MeshStandardMaterial({
      color: 0xd9a516, roughness: 0.25, metalness: 0.9,
      emissive: 0xffb020, emissiveIntensity: 1.1
    });
    const nanoGrp = new THREE.Group();
    nanoGrp.visible = false;
    followFx.add(nanoGrp);
    const shards = [];
    for (let i = 0; i < 16; i++) {
      const mesh = new THREE.Mesh(shardGeo, shardMat);
      nanoGrp.add(mesh);
      shards.push({ mesh: mesh, a: (i / 16) * Math.PI * 2, ring: i % 2, phase: i * 0.77 });
    }

    /* 7) 버프 오라 (공용) */
    const auraMat = new THREE.MeshBasicMaterial({
      color: 0x4fe6ff, transparent: true, opacity: 0, side: THREE.BackSide,
      depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false
    });
    const aura = new THREE.Mesh(new THREE.SphereGeometry(1.25, 18, 12), auraMat);
    aura.position.y = 1.0;
    aura.visible = false;
    followFx.add(aura);

    /* 8) 그웬 웹윙 (사용할 때만 rig.j.chest 에 붙인다) */
    const wingTex = webCanvas();
    const wingMat = new THREE.MeshBasicMaterial({
      map: wingTex, color: 0xffffff, transparent: true, opacity: 0.34,
      side: THREE.DoubleSide, depthWrite: false, toneMapped: false
    });
    const wings = [new THREE.Mesh(wingGeo(1), wingMat), new THREE.Mesh(wingGeo(-1), wingMat)];
    wings.forEach(function (w) { w.frustumCulled = false; });
    let wingHost = null;

    /* --------------------------------------- 느와르: 재질 투명화/복구 */
    const fadeMats = [], fadeSave = [];
    function pushMat(m) {
      if (!m || fadeMats.indexOf(m) >= 0) return;
      fadeMats.push(m);
      fadeSave.push({ t: m.transparent, o: m.opacity, d: m.depthWrite });
    }
    function fadeOn() {
      fadeOff();                       // 혹시 남아 있으면 먼저 복구
      const rig = player.rig;
      if (!rig || !rig.root) return;
      rig.root.traverse(function (o) {
        if (!o.isMesh || !o.material) return;
        if (Array.isArray(o.material)) {
          for (let i = 0; i < o.material.length; i++) pushMat(o.material[i]);
        } else pushMat(o.material);
      });
      for (let i = 0; i < fadeMats.length; i++) {
        const m = fadeMats[i];
        m.transparent = true;
        m.opacity = 0.25;
        m.depthWrite = false;
      }
    }
    /* ★ suits.js 는 슈트별 재질을 캐시해 공유한다. 여기서 건드린 재질을 못 돌려놓으면
       그 슈트는 게임이 끝날 때까지 반투명으로 남는다. 무조건·전부 되돌린다. */
    function fadeOff() {
      for (let i = 0; i < fadeMats.length; i++) {
        const m = fadeMats[i], s = fadeSave[i];
        if (!m || !s) continue;
        m.transparent = s.t;
        m.opacity = s.o;
        m.depthWrite = s.d;
        m.needsUpdate = true;
      }
      fadeMats.length = 0;
      fadeSave.length = 0;
    }

    /* --------------------------------------------------- 컨트롤러 본체 */
    const ctrl = {
      energy: 0,
      active: false,
      remain: 0,
      ready: false,
      suitId: normId(player.suitId),
      name: '', desc: '', color: '#ffffff',
      fxPulse: 0,
      fxTint: null,
      mods: {
        timeScale: 1, speedMul: 1, gravityMul: 1,
        glide: false, invisible: false, dashImpulse: null, damageMul: 1
      }
    };

    function resetMods() {
      const m = ctrl.mods;
      m.timeScale = 1; m.speedMul = 1; m.gravityMul = 1;
      m.glide = false; m.invisible = false; m.dashImpulse = null; m.damageMul = 1;
    }

    let def = DEF[ctrl.suitId];
    function applyDef() {
      ctrl.suitId = normId(ctrl.suitId);   // def 와 id 분기가 항상 같은 슈트를 가리키게
      def = DEF[ctrl.suitId];
      ctrl.name = def.name;
      ctrl.desc = def.desc;
      ctrl.color = def.color;
    }
    applyDef();

    /* ---------------------------------- crime 공개 API 로만 적 처리 */
    /* 카메라 각도를 한 순간만 적 쪽으로 돌려 crime.tryWebShot() 을 호출한다.
       이렇게 하면 점수·콤보·코쿤·현장 완료 처리가 전부 crime 쪽 규칙대로 돈다. */
    const dashVec = new V3();
    const MAX_SHOTS = 12;              // 폭주 방지 상한
    function shootAt(e, times) {
      if (!crime || !crime.tryWebShot) return false;
      if (!e || e.arrested || e.dead || !vecFin(e.pos) || !vecFin(player.pos)) return false;
      const n = Math.min(MAX_SHOTS, Math.max(1, Math.floor(fin(times, 1))));
      /* 카메라를 잠깐 훔쳐 쓰므로 어떤 예외가 나도 finally 로 반드시 원복 */
      const oy = player.camYaw, op = player.camPitch;
      const w0 = fin(e.webs, 0);
      try {
        _v.set(e.pos.x - player.pos.x,
          (e.pos.y + 1.0) - (player.pos.y + 1.5),
          e.pos.z - player.pos.z);
        const hz = Math.hypot(_v.x, _v.z) || 1e-4;
        player.camYaw = Math.atan2(_v.x, _v.z);
        player.camPitch = Math.atan2(_v.y, hz);
        for (let k = 0; k < n; k++) {
          if (e.arrested || e.dead) break;
          const before = fin(e.webs, 0);
          if (!crime.tryWebShot()) break;
          /* 조준 스코어 때문에 다른 적이 맞았을 수 있다 — 헛방이면 중단 */
          if (fin(e.webs, 0) === before && !e.arrested) break;
        }
      } finally {
        player.camYaw = oy;
        player.camPitch = op;
      }
      return e.arrested || fin(e.webs, 0) > w0;
    }

    /* 반경 안의 범인에게 거미줄. shots < 0 이면 포박될 때까지 */
    function aoeWeb(radius, shots) {
      if (!crime || !crime.enemies || !vecFin(player.pos)) return 0;
      _scratch.length = 0;
      let n = 0;
      try {
        /* crime.enemies 는 closeSite() 에서 splice 된다.
           반드시 스냅샷을 뜬 뒤에 쏜다 (순회 중 splice 금지) */
        const list = crime.enemies;
        const r2 = radius * radius;
        for (let i = 0; i < list.length; i++) {
          const e = list[i];
          if (!e || e.arrested || e.dead || !vecFin(e.pos)) continue;
          const dx = e.pos.x - player.pos.x;
          const dy = e.pos.y - player.pos.y;
          const dz = e.pos.z - player.pos.z;
          if (dx * dx + dy * dy + dz * dz > r2) continue;
          _scratch.push(e);
        }
        /* 겹쳐 선 적끼리 조준을 뺏길 수 있어서 제압형(shots<0)은 2회까지 훑는다.
           패스 수를 상수로 묶어 무한루프 가능성을 없앤다. */
        _hit.length = _scratch.length;
        for (let i = 0; i < _hit.length; i++) _hit[i] = false;
        const passes = shots < 0 ? 2 : 1;
        for (let p = 0; p < passes; p++) {
          for (let i = 0; i < _scratch.length; i++) {
            const e = _scratch[i];
            /* 스냅샷 이후 죽거나(dead) 체포됐을 수 있다 — 매번 재확인 */
            if (e.arrested || e.dead) continue;
            const hp = fin(e.T && e.T.hp, 3);
            const need = shots < 0
              ? Math.max(1, hp - fin(e.webs, 0))
              : fin(shots, 1);
            if (shootAt(e, need)) _hit[i] = true;
          }
        }
        for (let i = 0; i < _hit.length; i++) if (_hit[i]) n++;
      } finally {
        _scratch.length = 0;   // 예외가 나도 죽은 적 참조를 붙들지 않는다
        _hit.length = 0;
      }
      return n;
    }

    /* 시선 방향 임펄스. player.vel 에 직접 더하고 1프레임 동안 mods 로도 노출한다 */
    let dashHold = 0;
    function launch(power, upBias) {
      /* camYaw/camPitch 가 한 번이라도 NaN 이면 vel → pos → 카메라 → 도시 전체가
         NaN 이 된다. 입력·결과 양쪽을 유한값으로 강제한다. */
      const yaw = fin(player.camYaw, 0);
      const pitch = fin(player.camPitch, 0);
      const p = fin(power, 0);
      const cp = Math.cos(pitch);
      _dir.set(Math.sin(yaw) * cp, Math.sin(pitch), Math.cos(yaw) * cp);
      if (isNum(upBias)) _dir.y = Math.max(_dir.y, upBias);
      /* 길이 0 벡터 normalize 방지 (r128 normalize 는 0 을 반환한다) */
      const l2 = _dir.lengthSq();
      if (!isNum(l2) || l2 < 1e-6) _dir.set(0, 1, 0);
      else _dir.multiplyScalar(1 / Math.sqrt(l2));
      dashVec.copy(_dir).multiplyScalar(p);
      if (!vecFin(dashVec) || !vecFin(player.vel)) { dashVec.set(0, 0, 0); return; }
      player.vel.add(dashVec);
      if (player.grounded || player.state === 'ground') {
        player.grounded = false;
        player.state = 'air';
      }
      ctrl.mods.dashImpulse = dashVec;   // 참고용(이미 적용됨) — 1프레임 뒤 null
      dashHold = 1;
    }

    /* ------------------------------------------------------- 발동/종료 */
    let fxT = 0;          // 즉발 이펙트 남은 시간
    let fxKind = '';      // 'blossom' | 'venom' | 'dash'
    let fxMax = 1;

    function startFx(kind, dur) {
      /* fxMax 가 0 이면 update 에서 0/0 = NaN → scale/opacity 전파 */
      fxMax = Math.max(0.05, fin(dur, 0.5));
      fxT = fxMax;
      fxKind = kind;
    }

    function beginBuff() {
      endBuff();                 // 중첩 발동 시 이전 효과를 먼저 완전히 원복
      ctrl.active = true;
      ctrl.remain = def.dur > 0 ? def.dur : 1;
      ctrl.fxTint = def.tint || null;
      const m = ctrl.mods;
      const id = ctrl.suitId;
      if (id === 'advanced') {
        m.timeScale = 0.4;
        auraMat.color.set(0x4fe6ff); aura.visible = true;
      } else if (id === 'symbiote') {
        m.speedMul = 1.45; m.damageMul = 2; m.gravityMul = 0.85;
        auraMat.color.set(0x7a2ec8); aura.visible = true;
        for (let i = 0; i < tentacles.length; i++) tentacles[i].pivot.visible = true;
      } else if (id === 'iron') {
        m.speedMul = 1.5; m.damageMul = 1.5;
        auraMat.color.set(0xffb020); aura.visible = true;
        nanoGrp.visible = true;
      } else if (id === 'noir') {
        m.speedMul = 1.2; m.invisible = true;
        auraMat.color.set(0x24384f); aura.visible = true;
        fadeOn();
      } else if (id === 'gwen') {
        m.glide = true; m.gravityMul = 0.3;
        auraMat.color.set(0xff8fd0); aura.visible = true;
        attachWings();
      }
    }

    function attachWings() {
      detachWings();                         // 중첩 부착 방지 (idempotent)
      const rig = player.rig;
      if (!rig || !rig.j || !rig.j.chest) return;
      wingHost = rig.j.chest;
      wingHost.add(wings[0]);
      wingHost.add(wings[1]);
    }
    function detachWings() {
      /* wingHost 가 이미 버려진 rig 의 뼈여도 remove 는 안전하다.
         부모가 딴 데로 바뀐 경우까지 대비해 현재 부모에서도 뗀다. */
      for (let i = 0; i < wings.length; i++) {
        const w = wings[i];
        if (w.parent) w.parent.remove(w);
      }
      wingHost = null;
    }

    /* 진행중 효과를 즉시 끝내고 전부 원복.
       ★ 여기서 뭐가 터져도 mods 는 반드시 기본값으로 돌아가야 한다
         (안 돌아가면 timeScale 0.4 / gravity 0.3 이 영구히 남는다) */
    function endBuff() {
      try {
        fadeOff();          // mods.invisible 을 믿지 않는다 — 비어 있으면 no-op
        detachWings();
      } finally {
        resetMods();
        ctrl.active = false;
        ctrl.remain = 0;
        ctrl.fxTint = null;
        aura.visible = false;
        nanoGrp.visible = false;
        for (let i = 0; i < tentacles.length; i++) tentacles[i].pivot.visible = false;
      }
    }

    ctrl.trigger = function () {
      if (ctrl.active) return false;
      if (!vecFin(player.pos)) return false;         // NaN 상태에서는 아무것도 안 한다
      syncSuit();                                    // 슈트가 바뀌었는데 통보 못 받았을 때
      if (!(ctrl.energy >= 1)) {
        if (crime && crime.flash) {
          crime.flash('포커스 부족 — ' +
            Math.round(Math.max(0, fin(ctrl.energy, 0)) * 100) + '%', '#8899aa');
        }
        return false;
      }
      ctrl.energy = 0;
      ctrl.fxPulse = 1;
      const id = ctrl.suitId;

      if (id === 'classic') {
        worldFx.position.set(player.pos.x, player.pos.y, player.pos.z);
        blossom.visible = true;
        blossom.scale.set(1, 1, 1);
        blossomMat.opacity = 0.95;
        blossomMat.color.set(0xf2f5ff);
        rings[0].mesh.visible = true;
        rings[0].mat.color.set(0xffd166);
        startFx('blossom', def.fx);
        const n = aoeWeb(18, 1);
        if (player.sparks) {
          _v.copy(player.pos); _v.y += 1.2;
          player.sparks.burst(_v, 26, 1.6, 12);
        }
        if (NS.sfx && NS.sfx.thwip) NS.sfx.thwip(0.8);
        if (crime && crime.flash) crime.flash('웹 블라썸!  ' + n + '명 명중', '#ffd166');

      } else if (id === 'miles') {
        worldFx.position.set(player.pos.x, player.pos.y, player.pos.z);
        for (let i = 0; i < rings.length; i++) {
          rings[i].mesh.visible = true;
          rings[i].mat.color.set(0x4fd8ff);
        }
        makeBolts(22);
        bolts.visible = true;
        startFx('venom', def.fx);
        const n = aoeWeb(22, -1);
        launch(17, 0.55);
        if (player.sparks) {
          _v.copy(player.pos); _v.y += 1.2;
          player.sparks.burst(_v, 34, 2.2, 16);
        }
        if (NS.sfx && NS.sfx.pickup) NS.sfx.pickup(1.6);
        if (crime && crime.flash) crime.flash('베놈 블래스트!  ' + n + '명 제압', '#4fd8ff');

      } else if (id === 's2099') {
        launch(34, 0.16);
        for (let i = 0; i < ghosts.length; i++) {
          const g = ghosts[i];
          g.mesh.visible = true;
          g.mat.opacity = 0.55;
          g.mesh.position.set(
            player.pos.x - _dir.x * (0.9 + i * 1.1),
            player.pos.y + 0.95 - _dir.y * (0.9 + i * 1.1),
            player.pos.z - _dir.z * (0.9 + i * 1.1));
          g.mesh.scale.set(1, 1, 1);
        }
        startFx('dash', def.fx);
        if (NS.sfx && NS.sfx.jump) NS.sfx.jump();
        if (crime && crime.flash) crime.flash('가속 대시!', '#ff3348');

      } else {
        beginBuff();
        if (NS.sfx && NS.sfx.pickup) NS.sfx.pickup(1.3);
        if (crime && crime.flash) crime.flash(def.name + ' 발동!', def.color);
      }
      return true;
    };

    ctrl.setSuit = function (id) {
      endBuff();                     // 진행중 버프·재질·웹윙 전부 원복하고 나서 교체
      fxT = 0; fxKind = '';
      blossom.visible = false;
      bolts.visible = false;
      for (let i = 0; i < rings.length; i++) rings[i].mesh.visible = false;
      for (let i = 0; i < ghosts.length; i++) ghosts[i].mesh.visible = false;
      ctrl.suitId = normId(id);
      applyDef();
    };

    /* ★ game.js 는 player.setSuit() 만 부르고 abilities 에 통보하지 않을 수 있다.
       그러면 player.rig 가 통째로 교체돼 웹윙·투명화가 옛 rig 에 남는다.
       매 프레임 player.suitId 와 대조해 스스로 원복한다. */
    function syncSuit() {
      const pid = normId(player.suitId);
      if (pid !== ctrl.suitId) ctrl.setSuit(pid);
    }

    let extFocus = false;      // game.js 가 addFocus 를 직접 부르는지
    ctrl.addFocus = function (amount) {
      extFocus = true;
      ctrl.energy = Math.max(0, Math.min(1, fin(ctrl.energy, 0) + fin(amount, 0)));
    };

    /* ------------------------------------------------------- 매 프레임 */
    /* dt 는 timeScale 이 곱해져 들어올 수 있으므로 지속시간·게이지는 실제
       경과시간으로 계산한다 (배틀 포커스가 스스로 늘어나는 걸 방지) */
    let lastNow = 0;
    let clock = 0;             // time 인자가 없을 때 쓰는 자체 시계
    let prevArrests = fin(crime && crime.arrests, 0);

    ctrl.update = function (dt, time) {
      const now = (typeof performance !== 'undefined' ? performance.now() : Date.now()) * 0.001;
      let rdt = lastNow ? now - lastNow : fin(dt, 0);
      lastNow = now;
      if (!(rdt > 0)) rdt = 0;
      if (rdt > 0.1) rdt = 0.1;
      /* time 이 undefined/NaN 이면 sin/cos 가 전부 NaN → scale·position 오염 */
      clock += rdt;
      const t = isNum(time) ? time : clock;

      /* 슈트 교체를 놓치지 않는다 (mods/재질/웹윙 원복 보장) */
      syncSuit();

      /* 임펄스 노출은 1프레임만 */
      if (dashHold > 0) { dashHold--; if (dashHold <= 0) ctrl.mods.dashImpulse = null; }

      if (!isNum(ctrl.energy)) ctrl.energy = 0;

      /* 체포 감지 → 게이지 보너스.
         game.js 가 addFocus 를 직접 부르면 중복 지급을 막으려고 자동감지는 꺼진다 */
      if (crime && isNum(crime.arrests)) {
        if (!extFocus && crime.arrests > prevArrests) {
          ctrl.energy = Math.min(1,
            ctrl.energy + ARREST_GAIN * (crime.arrests - prevArrests));
        }
        prevArrests = crime.arrests;
      }

      /* 게이지 충전 */
      let g = CHARGE;
      if (fin(player.speedKmh, 0) >= FAST_KMH) g *= FAST_MUL;
      if (player.state === 'swing') g *= SWING_MUL;
      ctrl.energy = Math.max(0, Math.min(1, ctrl.energy + g * rdt));
      ctrl.ready = ctrl.energy >= 1 && !ctrl.active;

      if (ctrl.fxPulse > 0) ctrl.fxPulse = Math.max(0, ctrl.fxPulse - rdt * 3.2);

      /* 지속형 진행 */
      if (ctrl.active) {
        ctrl.remain -= rdt;
        if (ctrl.remain <= 0) {
          endBuff();
          if (crime && crime.flash) crime.flash(def.name + ' 종료', '#99a3b5');
        }
      }

      /* 따라다니는 이펙트 위치 (NaN 좌표는 그대로 두고 건너뛴다) */
      if (vecFin(player.pos)) {
        followFx.position.set(player.pos.x, player.pos.y, player.pos.z);
      }

      /* 오라 */
      if (aura.visible) {
        const k = 0.5 + 0.5 * Math.sin(t * 6);
        auraMat.opacity = (ctrl.suitId === 'noir' ? 0.1 : 0.16) * (0.6 + k * 0.4);
        const s = 1 + k * 0.06;
        aura.scale.set(s, s, s);
      }

      /* 촉수 */
      if (tentacles.length && tentacles[0].pivot.visible) {
        for (let i = 0; i < tentacles.length; i++) {
          const tn = tentacles[i];
          const w = Math.sin(t * 5 + tn.phase);
          const w2 = Math.cos(t * 3.7 + tn.phase);
          tn.pivot.rotation.x = Math.cos(tn.ang) * 0.5 + w * 0.28;
          tn.pivot.rotation.z = -Math.sin(tn.ang) * 0.5 + w2 * 0.28;
          tn.pivot.rotation.y = w2 * 0.2;
        }
      }

      /* 나노 파편 궤도 */
      if (nanoGrp.visible) {
        nanoGrp.rotation.y = t * 2.4;
        for (let i = 0; i < shards.length; i++) {
          const s = shards[i];
          const rad = s.ring ? 1.15 : 0.8;
          const y = 1.0 + Math.sin(t * 3 + s.phase) * (s.ring ? 0.55 : 0.3);
          s.mesh.position.set(Math.cos(s.a + t * (s.ring ? 1.1 : -1.6)) * rad, y,
            Math.sin(s.a + t * (s.ring ? 1.1 : -1.6)) * rad);
          s.mesh.rotation.x = t * 3 + s.phase;
          s.mesh.rotation.y = t * 2.2;
        }
      }

      /* 웹윙 펄럭임 — rig 가 통째로 갈렸으면 새 chest 로 다시 붙인다 */
      if (ctrl.mods.glide) {
        const rig = player.rig;
        const chest = rig && rig.j && rig.j.chest;
        if (chest && chest !== wingHost) attachWings();
        else if (!chest && wingHost) detachWings();
      } else if (wingHost) {
        detachWings();                   // glide 가 아닌데 붙어 있으면 잘못된 상태
      }
      if (wingHost) {
        const f = Math.sin(t * 7) * 0.12;
        wings[0].rotation.z = -0.1 + f;
        wings[1].rotation.z = 0.1 - f;
        wingMat.opacity = 0.3 + Math.abs(f);
      }

      /* 즉발 이펙트 */
      if (fxT > 0) {
        fxT -= rdt;
        const k = 1 - Math.max(0, fxT) / fxMax;      // 0 → 1

        if (fxKind === 'blossom') {
          const r = 2 + k * 17;
          blossom.scale.set(r, r, r);
          blossom.rotation.y = k * 0.7;
          blossomMat.opacity = 0.95 * (1 - k) * (1 - k);
          const rr = 2 + k * 19;
          rings[0].mesh.scale.set(rr, rr, rr);
          rings[0].mesh.position.y = 1.0;
          rings[0].mat.opacity = 0.7 * (1 - k);
        } else if (fxKind === 'venom') {
          for (let i = 0; i < rings.length; i++) {
            const rk = Math.max(0, Math.min(1, (k * fxMax - rings[i].delay) / (fxMax * 0.8)));
            const rr = 1.5 + rk * 21;
            rings[i].mesh.scale.set(rr, rr, rr);
            rings[i].mesh.position.y = 0.6 + i * 0.5;
            rings[i].mat.opacity = 0.75 * (1 - rk);
          }
          boltMat.opacity = 0.9 * (1 - k) * (0.6 + 0.4 * Math.sin(k * 40));
        } else if (fxKind === 'dash') {
          for (let i = 0; i < ghosts.length; i++) {
            const gm = ghosts[i];
            gm.mat.opacity = 0.55 * (1 - k) * (1 - i * 0.25);
            const s = 1 + k * 0.35;
            gm.mesh.scale.set(s, s, s);
          }
        }

        if (fxT <= 0) {
          fxKind = '';
          blossom.visible = false;
          bolts.visible = false;
          for (let i = 0; i < rings.length; i++) rings[i].mesh.visible = false;
          for (let i = 0; i < ghosts.length; i++) ghosts[i].mesh.visible = false;
        }
      }
    };

    ctrl.dispose = function () {
      endBuff();                       // 재질/웹윙 원복이 먼저
      scene.remove(followFx);
      scene.remove(worldFx);
      for (let i = 0; i < ghosts.length; i++) scene.remove(ghosts[i].mesh);
      /* GPU 리소스 해제 — create() 를 다시 부르면 누수된다 */
      const geos = [blossom.geometry, ringGeo, boltGeo, ghostGeo, tentGeo,
        shardGeo, aura.geometry, wings[0].geometry, wings[1].geometry];
      for (let i = 0; i < geos.length; i++) {
        if (geos[i] && geos[i].dispose) geos[i].dispose();
      }
      const mats = [blossomMat, boltMat, tentMat, shardMat, auraMat, wingMat];
      for (let i = 0; i < rings.length; i++) mats.push(rings[i].mat);
      for (let i = 0; i < ghosts.length; i++) mats.push(ghosts[i].mat);
      for (let i = 0; i < mats.length; i++) {
        if (mats[i] && mats[i].dispose) mats[i].dispose();
      }
      if (wingTex && wingTex.dispose) wingTex.dispose();
    };

    return ctrl;
  }

  NS.Abilities = { create: create, DEF: DEF };
})();
