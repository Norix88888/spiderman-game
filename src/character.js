/* =========================================================================
   character.js — 절차적 휴머노이드 리그 + 포즈 애니메이션
   캡슐(Lathe) 기반 바디, 관절 계층으로 달리기/스윙/낙하/벽타기 포즈를 생성.
   모델은 +Z 방향을 바라본다.
   ========================================================================= */
(function () {
  const NS = (window.SPIDER = window.SPIDER || {});
  const V3 = THREE.Vector3;

  /* 위/아래 반지름이 다른 캡슐. phiStart=-PI 로 두어 텍스처 u=0.5 가 정면(+Z) */
  function capsuleGeom(rTop, rBot, len, seg, capFlat) {
    seg = seg || 16;
    capFlat = capFlat == null ? 0.8 : capFlat;
    const pts = [], cs = 5;
    for (let i = cs; i >= 0; i--) {           // 아래 반구
      const a = (Math.PI / 2) * (i / cs);
      pts.push(new THREE.Vector2(Math.max(0.0001, Math.cos(a) * rBot),
        -len / 2 - Math.sin(a) * rBot * capFlat));
    }
    for (let i = 0; i <= cs; i++) {           // 위 반구
      const a = (Math.PI / 2) * (i / cs);
      pts.push(new THREE.Vector2(Math.max(0.0001, Math.cos(a) * rTop),
        len / 2 + Math.sin(a) * rTop * capFlat));
    }
    return new THREE.LatheGeometry(pts, seg, -Math.PI, Math.PI * 2);
  }

  function limb(mat, rTop, rBot, len, flatZ) {
    const g = capsuleGeom(rTop, rBot, len, 14);
    const m = new THREE.Mesh(g, mat);
    m.position.y = -len / 2;
    if (flatZ) m.scale.z = flatZ;
    m.castShadow = true;
    return m;
  }

  function joint(parent, x, y, z) {
    const o = new THREE.Object3D();
    o.position.set(x, y, z);
    parent.add(o);
    return o;
  }

  /* 눈 렌즈: 평면 Shape 를 구면에 투영해서 얼굴에 밀착.
     원작 마스크 렌즈 = 코 쪽(안쪽)은 뾰족하게 모이고, 바깥으로 갈수록
     크게 부풀어 위로 솟는 물방울꼴. x=0 이 안쪽 끝(코 쪽)이다. */
  function eyeMesh(mat, style, side, R, grow) {
    grow = grow || 1;
    const s = new THREE.Shape();
    if (style === 'goggle') {
      s.absarc(0.030 * grow, 0, 0.034 * grow, 0, Math.PI * 2, false);
    } else if (style === 'sharp') {
      // 2099 / 아이언 스파이더 : 각진 렌즈
      const w = 0.074 * grow, h = 0.046 * grow;
      s.moveTo(0, -h * 0.15);
      s.lineTo(w * 0.62, h * 0.95);
      s.lineTo(w, h * 0.55);
      s.lineTo(w * 0.88, -h * 0.45);
      s.lineTo(w * 0.24, -h * 0.72);
      s.closePath();
    } else {
      const wide = style === 'wide';
      const w = (wide ? 0.094 : 0.086) * grow;
      const h = (wide ? 0.060 : 0.054) * grow;
      // 안쪽 끝은 중심보다 '위'에 있고, 아래 선은 볼록하게 부풀어야 물방울이 된다
      s.moveTo(0, h * 0.18);                                    // 코 쪽 뾰족한 끝
      s.bezierCurveTo(w * 0.13, h * 0.74, w * 0.42, h * 1.00, w * 0.72, h * 0.90);
      s.bezierCurveTo(w * 0.96, h * 0.80, w * 1.02, h * 0.04, w * 0.82, -h * 0.38);
      s.bezierCurveTo(w * 0.58, -h * 0.62, w * 0.24, -h * 0.02, 0, h * 0.18);
    }
    const g = new THREE.ExtrudeGeometry(s, {
      depth: 0.012, bevelEnabled: true, bevelSize: 0.004,
      bevelThickness: 0.004, bevelSegments: 2, curveSegments: 14
    });
    // 구면 투영
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const rr = Math.max(0, R * R - x * x - y * y);
      p.setZ(i, Math.sqrt(rr) + z * 0.55);
    }
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, mat);
    m.scale.x = side;
    return m;
  }

  /* =====================================================================
     스킨드 바디로 만드는 최신 경로.
     BodyGen 이 뼈대에 씌운 "하나의 연속된 살"을 만들어 주므로
     관절이 조각처럼 끊기지 않는다. 눈/기계팔/후드만 여기서 얹는다.
     ===================================================================== */
  function buildSkinned(suitId) {
    const suit = NS.Suits.byId(suitId);
    const M = NS.Suits.materials(suit);
    const P = suit.parts;
    const pick = k => M[P[k]] || M.p;

    // BodyGen 재질 순서: 0=head 1=chest 2=abdomen 3=upperArm 4=forearm 5=hand 6=thigh 7=shin 8=foot
    const mats = [
      P.head === 's' ? M.s : (P.head === 'a' ? M.a : M.head),
      M.torso,
      P.abdomen === 's' ? M.s : M.abdomen,
      pick('upperArm'), pick('forearm'), pick('hand'),
      pick('thigh'), pick('shin'), pick('foot')
    ];

    const out = NS.BodyGen.build({ materials: mats, quality: 'high' });
    const root = out.root;
    const rig = { root: root, suit: suit, j: out.bones, mesh: out.mesh, skeleton: out.skeleton };
    const J = rig.j;

    out.mesh.castShadow = true;
    out.mesh.receiveShadow = false;
    out.mesh.frustumCulled = false;

    /* ---------------- 눈 (스파이더맨의 상징) ---------------- */
    /* 머리 단면(눈높이)의 반폭은 약 0.096, 앞면 z 는 약 0.097.
       렌즈가 그 밖으로 나가면 고글처럼 붕 떠 보이므로 안쪽에 맞춘다. */
    const HEAD_LOCAL_Y = 0.160;
    const eyeGrp = new THREE.Group();
    eyeGrp.position.set(0, HEAD_LOCAL_Y, 0.006);
    J.head.add(eyeGrp);
    const ER = 0.090;
    const goggle = suit.eye === 'goggle';
    for (let s = -1; s <= 1; s += 2) {
      // 테두리는 렌즈보다 살짝 크게(=검은 굵은 라인) + 조금 뒤쪽에
      const rim = eyeMesh(M.eyeRim, suit.eye, s, ER + 0.006, 1.16);
      const lens = eyeMesh(M.eye, suit.eye, s, ER + 0.010, 1.0);
      const off = 0.011;
      rim.position.set(s * off, 0, 0);
      lens.position.set(s * off, 0, 0);
      rim.scale.x = s; lens.scale.x = s;
      rim.rotation.z = s * -0.13;
      lens.rotation.z = s * -0.13;
      eyeGrp.add(rim); eyeGrp.add(lens);
      if (goggle) {
        const band = new THREE.Mesh(new THREE.TorusGeometry(0.040, 0.008, 8, 20), M.eyeRim);
        band.position.set(s * 0.041, 0, ER - 0.016);
        eyeGrp.add(band);
      }
    }

    /* ---------------- 후드 (그웬) ---------------- */
    if (suit.hood) {
      const hood = new THREE.Mesh(
        new THREE.SphereGeometry(0.155, 18, 14, 0, Math.PI * 2, 0, Math.PI * 0.62), M.p);
      hood.position.set(0, 0.15, -0.03);
      hood.scale.set(1.12, 1.2, 1.2);
      J.head.add(hood);
      const collar = new THREE.Mesh(new THREE.TorusGeometry(0.145, 0.045, 8, 18), M.p);
      collar.position.set(0, 0.3, -0.02);
      collar.rotation.x = Math.PI / 2;
      collar.scale.set(1, 1, 1.35);
      J.chest.add(collar);
    }

    /* ---------------- 아이언 스파이더 기계팔 ---------------- */
    if (suit.arms) {
      rig.ironArms = [];
      for (let i = 0; i < 4; i++) {
        const side = i % 2 === 0 ? 1 : -1;
        const up = i < 2 ? 1 : 0;
        const a0 = new THREE.Object3D();
        a0.position.set(side * 0.11, up ? 0.24 : 0.08, -0.1);
        J.chest.add(a0);
        const seg = (len, r) => {
          const g = capsuleGeom(r * 0.72, r, len, 10);
          const m = new THREE.Mesh(g, M.metalTrim);
          m.position.y = -len / 2;
          m.castShadow = true;
          return m;
        };
        a0.add(seg(0.42, 0.035));
        const a1 = new THREE.Object3D(); a1.position.y = -0.42; a0.add(a1);
        a1.add(seg(0.4, 0.028));
        const a2 = new THREE.Object3D(); a2.position.y = -0.4; a1.add(a2);
        a2.add(seg(0.3, 0.02));
        const tip = new THREE.Mesh(new THREE.ConeGeometry(0.026, 0.1, 10), M.metalTrim);
        tip.position.y = -0.34; tip.rotation.x = Math.PI;
        a2.add(tip);
        rig.ironArms.push({ a0, a1, a2, phase: i * 1.7, side, up });
      }
    }

    /* ---------------- 웹슈터 ---------------- */
    ['L', 'R'].forEach(sd => {
      const ws = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.032, 12), M.metalTrim);
      ws.position.set(0, -0.22, 0.01);
      ws.rotation.x = Math.PI / 2;
      J['elbow' + sd].add(ws);
    });

    rig.pose = {};
    rig.landTimer = 0;
    return rig;
  }

  /* --------------------------------------------------------------- build */
  function buildLegacy(suitId) {
    const suit = NS.Suits.byId(suitId);
    const M = NS.Suits.materials(suit);
    const P = suit.parts;
    const pick = k => M[P[k]] || M.p;

    const root = new THREE.Group();      // 발바닥 원점, +Z 정면
    const rig = { root: root, suit: suit, j: {}, extras: [] };
    const J = rig.j;

    const D = {
      hip: 0.98, spine: 0.16, chest: 0.30, neck: 0.20,
      upperArm: 0.29, foreArm: 0.27, hand: 0.13,
      thigh: 0.45, shin: 0.43, foot: 0.20
    };

    J.hips = joint(root, 0, D.hip, 0);
    J.hips.add(limb(M.abdomen, 0.145, 0.15, 0.2, 0.72)).position.y = 0;
    // 골반 메시 위치 보정
    J.hips.children[0].position.y = -0.02;

    J.spine = joint(J.hips, 0, 0.02, 0);
    const absMesh = limb(M.abdomen, 0.155, 0.14, D.spine, 0.7);
    absMesh.position.y = D.spine / 2 - 0.02;
    J.spine.add(absMesh);

    J.chest = joint(J.spine, 0, D.spine, 0);
    const chestMesh = limb(M.torso, 0.135, 0.185, D.chest, 0.68);
    chestMesh.position.y = D.chest / 2;
    J.chest.add(chestMesh);
    // 어깨 근육
    for (let s = -1; s <= 1; s += 2) {
      const sh = new THREE.Mesh(new THREE.SphereGeometry(0.088, 14, 10), pick('upperArm'));
      sh.position.set(s * 0.185, D.chest * 0.86, 0);
      sh.scale.set(1, 0.9, 0.92);
      sh.castShadow = true;
      J.chest.add(sh);
    }

    J.neck = joint(J.chest, 0, D.chest + 0.02, 0);
    const neckMesh = limb(pick('head'), 0.058, 0.07, 0.09, 1);
    neckMesh.position.y = 0.045;
    J.neck.add(neckMesh);

    J.head = joint(J.neck, 0, 0.09, 0);
    const HEAD_R = 0.132;
    const headMesh = new THREE.Mesh(new THREE.SphereGeometry(HEAD_R, 22, 18), M.head);
    headMesh.position.y = 0.1;
    headMesh.scale.set(0.94, 1.06, 1.0);
    headMesh.castShadow = true;
    J.head.add(headMesh);
    // 턱
    const jaw = new THREE.Mesh(new THREE.SphereGeometry(0.1, 16, 12), M.head);
    jaw.position.set(0, 0.045, 0.022);
    jaw.scale.set(0.92, 0.78, 1.0);
    J.head.add(jaw);

    // 눈
    const eyeGrp = new THREE.Group();
    eyeGrp.position.y = 0.1;
    J.head.add(eyeGrp);
    for (let s = -1; s <= 1; s += 2) {
      const rim = eyeMesh(M.eyeRim, suit.eye, s, HEAD_R + 0.002);
      const lens = eyeMesh(M.eye, suit.eye, s, HEAD_R + 0.012);
      const off = suit.eye === 'goggle' ? 0.062 : 0.05;
      rim.position.set(s * off, 0.012, 0);
      lens.position.set(s * off, 0.012, 0);
      lens.scale.multiplyScalar(0.84);
      lens.scale.x *= s < 0 ? 1 : 1;
      lens.scale.x = s * 0.84;
      rim.scale.x = s * 1.0;
      rim.rotation.z = s * -0.12;
      lens.rotation.z = s * -0.12;
      eyeGrp.add(rim); eyeGrp.add(lens);
      if (suit.eye === 'goggle') {
        const band = new THREE.Mesh(new THREE.TorusGeometry(0.056, 0.012, 8, 20), M.eyeRim);
        band.position.set(s * 0.062, 0.012, HEAD_R - 0.01);
        eyeGrp.add(band);
      }
    }
    rig.eyeMats = [M.eye];

    // 후드 (그웬)
    if (suit.hood) {
      const hood = new THREE.Mesh(new THREE.SphereGeometry(0.18, 18, 14, 0, Math.PI * 2, 0, Math.PI * 0.62), M.p);
      hood.position.set(0, 0.08, -0.035);
      hood.scale.set(1.05, 1.15, 1.15);
      J.head.add(hood);
      const collar = new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.05, 8, 18), M.p);
      collar.position.set(0, D.chest * 0.92, -0.02);
      collar.rotation.x = Math.PI / 2;
      collar.scale.set(1, 1, 1.4);
      J.chest.add(collar);
    }

    // 팔
    ['L', 'R'].forEach((sd, i) => {
      const s = sd === 'L' ? 1 : -1;
      const sh = joint(J.chest, s * 0.2, D.chest * 0.86, 0);
      sh.add(limb(pick('upperArm'), 0.072, 0.056, D.upperArm, 0.95));
      const el = joint(sh, 0, -D.upperArm, 0);
      el.add(limb(pick('forearm'), 0.058, 0.046, D.foreArm, 0.95));
      const hd = joint(el, 0, -D.foreArm, 0);
      const hand = limb(pick('hand'), 0.05, 0.038, D.hand, 0.62);
      hand.scale.x = 1.15;
      hd.add(hand);
      // 손가락 덩어리
      const fing = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 8), pick('hand'));
      fing.position.y = -D.hand + 0.01;
      fing.scale.set(1.2, 0.75, 0.55);
      hd.add(fing);
      // 웹슈터
      const ws = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.035, 12), M.metalTrim);
      ws.rotation.x = Math.PI / 2;
      ws.position.set(0, -D.foreArm + 0.04, 0.012);
      ws.rotation.x = 0;
      el.add(ws);

      J['shoulder' + sd] = sh; J['elbow' + sd] = el; J['hand' + sd] = hd;
    });

    // 다리
    ['L', 'R'].forEach(sd => {
      const s = sd === 'L' ? 1 : -1;
      const hp = joint(J.hips, s * 0.105, -0.05, 0);
      hp.add(limb(pick('thigh'), 0.095, 0.072, D.thigh, 0.95));
      const kn = joint(hp, 0, -D.thigh, 0);
      kn.add(limb(pick('shin'), 0.072, 0.05, D.shin, 0.95));
      const ft = joint(kn, 0, -D.shin, 0);
      const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.105, 0.075, D.foot), pick('foot'));
      shoe.position.set(0, -0.03, 0.045);
      shoe.castShadow = true;
      ft.add(shoe);
      const toe = new THREE.Mesh(new THREE.SphereGeometry(0.055, 12, 8), pick('foot'));
      toe.position.set(0, -0.03, 0.045 + D.foot / 2);
      toe.scale.set(0.95, 0.7, 0.9);
      ft.add(toe);
      J['hip' + sd] = hp; J['knee' + sd] = kn; J['foot' + sd] = ft;
    });

    // 아이언 스파이더 기계팔
    if (suit.arms) {
      rig.ironArms = [];
      for (let i = 0; i < 4; i++) {
        const side = i % 2 === 0 ? 1 : -1;
        const up = i < 2 ? 1 : 0;
        const a0 = joint(J.chest, side * 0.13, D.chest * (up ? 0.72 : 0.34), -0.1);
        const seg = (len, r) => {
          const g = capsuleGeom(r * 0.72, r, len, 10);
          const m = new THREE.Mesh(g, M.metalTrim);
          m.position.y = -len / 2;
          m.castShadow = true;
          return m;
        };
        a0.add(seg(0.42, 0.035));
        const a1 = joint(a0, 0, -0.42, 0); a1.add(seg(0.4, 0.028));
        const a2 = joint(a1, 0, -0.4, 0); a2.add(seg(0.3, 0.02));
        const tip = new THREE.Mesh(new THREE.ConeGeometry(0.026, 0.1, 10), M.metalTrim);
        tip.position.y = -0.34; tip.rotation.x = Math.PI;
        a2.add(tip);
        rig.ironArms.push({ a0, a1, a2, phase: i * 1.7, side, up });
      }
    }

    root.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = false; } });

    rig.D = D;
    rig.pose = {};      // 현재 보간중인 오일러값
    rig.landTimer = 0;
    return rig;
  }

  /* --------------------------------------------------------------- poses */
  const T = {};   // 재사용 타겟 버퍼
  function set(name, x, y, z) { T[name] = T[name] || [0, 0, 0]; T[name][0] = x; T[name][1] = y; T[name][2] = z; }
  function clearT() { for (const k in T) { T[k][0] = T[k][1] = T[k][2] = 0; } }

  const POSE_KEYS = ['hips', 'spine', 'chest', 'neck', 'head',
    'shoulderL', 'elbowL', 'handL', 'shoulderR', 'elbowR', 'handR',
    'hipL', 'kneeL', 'footL', 'hipR', 'kneeR', 'footR'];

  function poseIdle(t) {
    const b = Math.sin(t * 1.8) * 0.03;
    set('spine', -0.04 + b, 0, 0);
    set('chest', 0.05, 0, 0);
    set('head', -0.03 - b, Math.sin(t * 0.5) * 0.14, 0);
    set('shoulderL', 0.05, 0, -0.13 - b * 0.5);
    set('shoulderR', 0.05, 0, 0.13 + b * 0.5);
    set('elbowL', -0.22, 0, 0); set('elbowR', -0.22, 0, 0);
    set('hipL', -0.03, 0, 0.03); set('hipR', -0.03, 0, -0.03);
    set('kneeL', -0.08, 0, 0); set('kneeR', -0.08, 0, 0);
  }

  function poseRun(t, speed) {
    const f = Math.min(1, speed / 15);
    const c = Math.cos(t), s = Math.sin(t);
    const amp = 0.55 + f * 0.62;
    set('spine', 0.1 + f * 0.28, 0, 0);
    set('chest', 0.06 + f * 0.1, s * 0.12, 0);
    set('head', -0.12 - f * 0.3, 0, 0);
    set('hips', 0, s * 0.14, 0);

    set('hipL', s * amp - 0.05, 0, 0.04);
    set('hipR', -s * amp - 0.05, 0, -0.04);
    set('kneeL', -Math.max(0, -s) * 1.5 - 0.2 - f * 0.3, 0, 0);
    set('kneeR', -Math.max(0, s) * 1.5 - 0.2 - f * 0.3, 0, 0);
    set('footL', s * 0.3 + 0.1, 0, 0);
    set('footR', -s * 0.3 + 0.1, 0, 0);

    set('shoulderL', -s * amp * 0.85, 0, -0.16);
    set('shoulderR', s * amp * 0.85, 0, 0.16);
    set('elbowL', -0.9 - Math.max(0, -s) * 0.7, 0, 0);
    set('elbowR', -0.9 - Math.max(0, s) * 0.7, 0, 0);
  }

  function poseAir(t, vy) {
    const up = vy > 0;
    set('spine', up ? -0.12 : 0.16, 0, 0);
    set('chest', 0.1, Math.sin(t * 2) * 0.06, 0);
    set('head', -0.2, 0, 0);
    set('shoulderL', -2.1 + Math.sin(t * 3) * 0.1, 0, -0.5);
    set('shoulderR', -2.0 + Math.cos(t * 3) * 0.1, 0, 0.55);
    set('elbowL', -0.7, 0, 0); set('elbowR', -0.85, 0, 0);
    set('hipL', -0.5 + Math.sin(t * 2.4) * 0.15, 0, 0.16);
    set('hipR', 0.32 + Math.cos(t * 2.4) * 0.15, 0, -0.2);
    set('kneeL', -1.1, 0, 0); set('kneeR', -0.35, 0, 0);
    set('footL', 0.35, 0, 0); set('footR', 0.3, 0, 0);
  }

  /* 스윙: 몸을 뒤로 눕히고 다리를 뒤로 흘림 (팔은 이후 anchor 로 조준) */
  function poseSwing(t, speed) {
    const sw = Math.sin(t * 1.6);
    set('spine', -0.28, 0, 0);
    set('chest', -0.12, sw * 0.08, 0);
    set('head', 0.35, 0, 0);
    set('hips', 0.1, sw * 0.1, 0);
    set('shoulderL', -0.4, 0, -0.6);
    set('shoulderR', -0.4, 0, 0.6);
    set('elbowL', -0.5, 0, 0); set('elbowR', -0.5, 0, 0);
    set('hipL', 0.85 + sw * 0.18, 0, 0.12);
    set('hipR', 0.6 - sw * 0.22, 0, -0.14);
    set('kneeL', -0.75, 0, 0); set('kneeR', -1.3, 0, 0);
    set('footL', 0.4, 0, 0); set('footR', 0.5, 0, 0);
  }

  /* 다이브: 슈퍼맨 자세 (루트 피치는 player 가 담당) */
  function poseDive(t) {
    set('spine', -0.1, 0, 0);
    set('chest', -0.06, 0, 0);
    set('head', 0.5, 0, 0);
    set('shoulderL', -0.15, 0, -1.35);
    set('shoulderR', -0.15, 0, 1.35);
    set('elbowL', -0.1, 0, 0); set('elbowR', -0.1, 0, 0);
    set('hipL', 0.12, 0, 0.1); set('hipR', 0.12, 0, -0.1);
    set('kneeL', -0.12 - Math.sin(t * 3) * 0.06, 0, 0);
    set('kneeR', -0.12 + Math.sin(t * 3) * 0.06, 0, 0);
    set('footL', 0.5, 0, 0); set('footR', 0.5, 0, 0);
  }

  /* 벽 붙기: 사지를 벌린 크롤 자세 */
  function poseWall(t, moving) {
    const c = Math.sin(t * 6) * (moving ? 1 : 0);
    set('spine', -0.15, 0, 0);
    set('chest', -0.1, c * 0.15, 0);
    set('head', 0.75, c * 0.2, 0);
    set('shoulderL', -2.25 + c * 0.5, 0, -0.65);
    set('shoulderR', -2.25 - c * 0.5, 0, 0.65);
    set('elbowL', -0.6 - Math.max(0, c) * 0.5, 0, 0);
    set('elbowR', -0.6 - Math.max(0, -c) * 0.5, 0, 0);
    set('hipL', 0.55 - c * 0.4, 0, 0.55);
    set('hipR', 0.55 + c * 0.4, 0, -0.55);
    set('kneeL', -1.5, 0, 0); set('kneeR', -1.5, 0, 0);
    set('footL', 0.7, 0, 0); set('footR', 0.7, 0, 0);
  }

  /* 착지: 3점 착지 */
  function poseLand(k) {
    set('hips', 0.25 * k, 0, 0);
    set('spine', 0.45 * k, 0.2 * k, 0);
    set('chest', 0.2 * k, 0, 0);
    set('head', -0.5 * k, 0.2 * k, 0);
    set('shoulderL', -0.5 * k, 0, -0.35 * k);
    set('shoulderR', 1.5 * k, 0.3 * k, 0.55 * k);
    set('elbowL', -1.9 * k, 0, 0); set('elbowR', -0.25 * k, 0, 0);
    set('hipL', 1.5 * k, 0, 0.35 * k);
    set('hipR', 0.35 * k, 0, -0.2 * k);
    set('kneeL', -1.9 * k, 0, 0); set('kneeR', -1.5 * k, 0, 0);
    set('footL', 0.5 * k, 0, 0); set('footR', 0.9 * k, 0, 0);
  }

  const _q = new THREE.Quaternion(), _v = new V3(), _m = new THREE.Matrix4();
  const UPN = new V3(0, -1, 0);

  /* 팔을 목표 지점으로 조준 (월드 좌표) */
  function aimArm(rig, side, worldTarget, bend) {
    const sh = rig.j['shoulder' + side];
    if (!sh) return;
    sh.updateWorldMatrix(true, false);
    _m.copy(sh.matrixWorld).invert();
    _v.copy(worldTarget).applyMatrix4(_m).normalize();
    _q.setFromUnitVectors(UPN, _v);
    sh.quaternion.slerp(_q, 0.55);
    const el = rig.j['elbow' + side];
    el.rotation.x += ((bend == null ? -0.25 : bend) - el.rotation.x) * 0.4;
    el.rotation.y *= 0.7; el.rotation.z *= 0.7;
  }

  function update(rig, st, dt) {
    const t = st.time;
    clearT();
    switch (st.mode) {
      case 'run': poseRun(st.cycle, st.speed); break;
      case 'idle': poseIdle(t); break;
      case 'air': poseAir(t, st.vy); break;
      case 'swing': poseSwing(t, st.speed); break;
      case 'dive': poseDive(t); break;
      case 'wall': poseWall(t, st.moving); break;
      default: poseIdle(t);
    }
    // 착지 블렌드
    if (rig.landTimer > 0) {
      rig.landTimer = Math.max(0, rig.landTimer - dt);
      const k = Math.min(1, rig.landTimer / 0.34);
      const saved = {};
      POSE_KEYS.forEach(n => { if (T[n]) saved[n] = T[n].slice(); });
      poseLand(1);
      POSE_KEYS.forEach(n => {
        if (!T[n]) return;
        const s = saved[n] || [0, 0, 0];
        for (let i = 0; i < 3; i++) T[n][i] = s[i] * (1 - k) + T[n][i] * k;
      });
    }

    const rate = 1 - Math.exp(-(st.snap || 14) * dt);
    for (let i = 0; i < POSE_KEYS.length; i++) {
      const n = POSE_KEYS[i], j = rig.j[n], v = T[n];
      if (!j || !v) continue;
      j.rotation.x += (v[0] - j.rotation.x) * rate;
      j.rotation.y += (v[1] - j.rotation.y) * rate;
      j.rotation.z += (v[2] - j.rotation.z) * rate;
    }

    // 기계팔
    if (rig.ironArms) {
      const active = st.mode === 'swing' || st.mode === 'dive' || st.mode === 'air';
      rig.ironArms.forEach(a => {
        const w = Math.sin(t * 2.2 + a.phase);
        const open = active ? 1 : 0.18;
        const tx = (a.up ? -2.2 : -1.5) * open - 0.25;
        const tz = a.side * (0.9 + (a.up ? 0.35 : -0.2)) * open;
        a.a0.rotation.x += (tx + w * 0.12 * open - a.a0.rotation.x) * 0.08;
        a.a0.rotation.z += (tz - a.a0.rotation.z) * 0.08;
        a.a1.rotation.x += ((1.5 * open + w * 0.2 * open) - a.a1.rotation.x) * 0.08;
        a.a2.rotation.x += ((-1.1 * open - w * 0.25 * open) - a.a2.rotation.x) * 0.08;
      });
    }
  }

  /* 손의 월드 좌표 */
  function handWorld(rig, side, out) {
    const h = rig.j['hand' + side];
    h.updateWorldMatrix(true, false);
    out.setFromMatrixPosition(h.matrixWorld);
    // 손끝(웹슈터) 쪽으로 살짝 이동
    out.y -= 0.02;
    return out;
  }

  /* BodyGen 이 있으면 스킨드 바디, 없으면 예전 조각 방식으로 폴백 */
  function build(suitId) {
    if (NS.BodyGen) {
      try { return buildSkinned(suitId); }
      catch (e) { console.warn('스킨드 바디 실패 → 구버전으로 폴백', e); }
    }
    return buildLegacy(suitId);
  }

  NS.Character = { build, update, aimArm, handWorld, capsuleGeom, buildLegacy };
})();
