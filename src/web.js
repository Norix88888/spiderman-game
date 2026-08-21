/* =========================================================================
   web.js — 진짜 밧줄처럼 보이는 거미줄
   · 직선/사각형이 아니라 중력으로 늘어지는 현수선(catenary) + 장력에 따라 팽팽해짐
   · 원형 단면 튜브 메시(꼬인 실 굴곡 포함), 손 쪽은 가늘고 부착점 쪽은 굵게
   · 발사 순간엔 줄이 뻗어나가고, 부착점엔 둥근 거미줄 자국이 남는다
   ========================================================================= */
(function () {
  const NS = (window.SPIDER = window.SPIDER || {});
  const V3 = THREE.Vector3;

  const SEG = 30;    // 길이 분할
  const SIDE = 7;    // 단면 분할

  function makeSilkTexture() {
    const W = 64, H = 256;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const x = c.getContext('2d');
    x.fillStyle = '#f2f4ff'; x.fillRect(0, 0, W, H);
    for (let i = 0; i < 90; i++) {
      x.strokeStyle = 'rgba(150,160,190,' + (0.06 + Math.random() * 0.22) + ')';
      x.lineWidth = Math.random() * 1.6 + 0.3;
      const off = Math.random() * W;
      x.beginPath();
      x.moveTo(off, 0);
      x.bezierCurveTo(off + 10, H * 0.33, off - 10, H * 0.66, off, H);
      x.stroke();
    }
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(1, 8);
    return t;
  }
  let silk = null;

  /* ------------------------------------------------------------- 줄 */
  function createStrand(scene, opt) {
    opt = opt || {};
    if (!silk) silk = makeSilkTexture();

    const count = SEG * SIDE;
    const pos = new Float32Array(count * 3);
    const nor = new Float32Array(count * 3);
    const uv = new Float32Array(count * 2);
    const idx = [];
    for (let i = 0; i < SEG - 1; i++) {
      for (let j = 0; j < SIDE; j++) {
        const a = i * SIDE + j;
        const b = i * SIDE + ((j + 1) % SIDE);
        const c = (i + 1) * SIDE + j;
        const d = (i + 1) * SIDE + ((j + 1) % SIDE);
        idx.push(a, c, b, b, c, d);
      }
    }
    for (let i = 0; i < SEG; i++) {
      for (let j = 0; j < SIDE; j++) {
        const k = (i * SIDE + j) * 2;
        uv[k] = j / SIDE; uv[k + 1] = i / (SEG - 1);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.boundingSphere = new THREE.Sphere(new V3(), 1e6);
    geo.boundingBox = null;

    const mat = new THREE.MeshStandardMaterial({
      map: silk,
      color: 0xf4f6ff,
      roughness: 0.62,
      metalness: 0.0,
      emissive: 0x8fa4d8,
      emissiveIntensity: 0.28,
      side: THREE.DoubleSide
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.visible = false;
    mesh.castShadow = false;
    scene.add(mesh);

    // 작업용 벡터
    const P = []; for (let i = 0; i < SEG; i++) P.push(new V3());
    const tan = new V3(), nrm = new V3(), bin = new V3(), prevN = new V3(0, 0, 1);
    const tmp = new V3(), a = new V3(), b = new V3();

    const state = {
      mesh,
      radius: opt.radius || 0.055,
      visible: false,
      show() { mesh.visible = true; state.visible = true; },
      hide() { mesh.visible = false; state.visible = false; },
      /* from/to: 월드좌표, tension 0(늘어짐)~1(팽팽), grow 0~1 발사 진행도 */
      update(from, to, tension, time, grow) {
        if (grow == null) grow = 1;
        a.copy(from);
        b.copy(to).sub(from).multiplyScalar(Math.min(1, Math.max(0.02, grow))).add(from);

        const len = a.distanceTo(b);
        const sagAmt = len * 0.14 * (1 - Math.min(1, tension)) + 0.12;
        const wob = (1 - Math.min(1, tension)) * 0.35;

        for (let i = 0; i < SEG; i++) {
          const t = i / (SEG - 1);
          const p = P[i];
          p.lerpVectors(a, b, t);
          // 현수선 처짐
          p.y -= sagAmt * 4 * t * (1 - t);
          // 잔진동 (장력 낮을수록 크게)
          const s = Math.sin(t * Math.PI);
          p.x += Math.sin(t * 9.0 + time * 7.0) * wob * s * 0.16;
          p.z += Math.cos(t * 7.5 + time * 6.2) * wob * s * 0.16;
        }

        // 평행수송 프레임으로 트위스트 없는 튜브 생성
        prevN.set(0, 1, 0);
        const pa = geo.attributes.position.array;
        const na = geo.attributes.normal.array;
        for (let i = 0; i < SEG; i++) {
          if (i === 0) tan.subVectors(P[1], P[0]);
          else if (i === SEG - 1) tan.subVectors(P[SEG - 1], P[SEG - 2]);
          else tan.subVectors(P[i + 1], P[i - 1]);
          if (tan.lengthSq() < 1e-10) tan.set(0, 1, 0);
          tan.normalize();

          nrm.copy(prevN).addScaledVector(tan, -prevN.dot(tan));
          if (nrm.lengthSq() < 1e-8) {
            nrm.set(Math.abs(tan.y) > 0.9 ? 1 : 0, Math.abs(tan.y) > 0.9 ? 0 : 1, 0);
            nrm.addScaledVector(tan, -nrm.dot(tan));
          }
          nrm.normalize();
          prevN.copy(nrm);
          bin.crossVectors(tan, nrm);

          const tt = i / (SEG - 1);
          // 손끝은 가늘게, 부착점은 굵게 + 양 끝 페더링
          let r = state.radius * (0.55 + 0.6 * tt);
          r *= 0.35 + 0.65 * Math.sin(Math.min(1, tt * 6) * Math.PI * 0.5);
          r *= 1 + 0.12 * Math.sin(tt * 40.0);

          for (let j = 0; j < SIDE; j++) {
            const ang = (j / SIDE) * Math.PI * 2 + tt * 5.0;   // 꼬임
            const cx = Math.cos(ang), sy = Math.sin(ang);
            const rr = r * (1 + 0.16 * Math.sin(ang * 3 + tt * 22));
            const k = (i * SIDE + j) * 3;
            tmp.set(nrm.x * cx + bin.x * sy, nrm.y * cx + bin.y * sy, nrm.z * cx + bin.z * sy);
            pa[k] = P[i].x + tmp.x * rr;
            pa[k + 1] = P[i].y + tmp.y * rr;
            pa[k + 2] = P[i].z + tmp.z * rr;
            na[k] = tmp.x; na[k + 1] = tmp.y; na[k + 2] = tmp.z;
          }
        }
        geo.attributes.position.needsUpdate = true;
        geo.attributes.normal.needsUpdate = true;
      }
    };
    return state;
  }

  /* --------------------------------------------------- 부착점 거미줄 자국 */
  function splatTexture(variant) {
    const S = 256, c = document.createElement('canvas');
    c.width = S; c.height = S;
    const x = c.getContext('2d');
    x.clearRect(0, 0, S, S);
    const cx = S / 2, cy = S / 2;
    const spokes = 9 + variant % 4;
    const R = S * 0.46;

    x.strokeStyle = 'rgba(244,246,255,0.95)';
    x.lineCap = 'round';
    const ang = [];
    for (let i = 0; i < spokes; i++) {
      ang.push((i / spokes) * Math.PI * 2 + (Math.random() - 0.5) * 0.32);
    }
    // 방사줄
    for (let i = 0; i < spokes; i++) {
      const a = ang[i];
      const len = R * (0.7 + Math.random() * 0.42);
      x.lineWidth = 2.6 + Math.random() * 2.4;
      x.beginPath();
      x.moveTo(cx, cy);
      x.quadraticCurveTo(
        cx + Math.cos(a + 0.12) * len * 0.5, cy + Math.sin(a + 0.12) * len * 0.5,
        cx + Math.cos(a) * len, cy + Math.sin(a) * len);
      x.stroke();
    }
    // 나선 고리
    for (let r = 1; r <= 4; r++) {
      const rad = R * (0.22 + r * 0.19) * (0.85 + Math.random() * 0.25);
      x.lineWidth = 1.6 + Math.random() * 1.4;
      x.beginPath();
      for (let i = 0; i <= spokes; i++) {
        const a0 = ang[i % spokes], a1 = ang[(i + 1) % spokes];
        const x0 = cx + Math.cos(a0) * rad, y0 = cy + Math.sin(a0) * rad;
        const am = (a0 + (a1 < a0 ? a1 + Math.PI * 2 : a1)) / 2;
        const sg = rad * 0.8;
        const xm = cx + Math.cos(am) * sg, ym = cy + Math.sin(am) * sg;
        const x1 = cx + Math.cos(a1) * rad, y1 = cy + Math.sin(a1) * rad;
        if (i === 0) x.moveTo(x0, y0);
        x.quadraticCurveTo(2 * xm - (x0 + x1) / 2, 2 * ym - (y0 + y1) / 2, x1, y1);
      }
      x.stroke();
    }
    // 중앙 덩어리 + 물방울
    const g = x.createRadialGradient(cx, cy, 0, cx, cy, S * 0.14);
    g.addColorStop(0, 'rgba(248,250,255,0.98)');
    g.addColorStop(0.6, 'rgba(230,236,255,0.6)');
    g.addColorStop(1, 'rgba(230,236,255,0)');
    x.fillStyle = g;
    x.beginPath(); x.arc(cx, cy, S * 0.14, 0, Math.PI * 2); x.fill();
    x.fillStyle = 'rgba(246,248,255,0.85)';
    for (let i = 0; i < 14; i++) {
      const a = Math.random() * Math.PI * 2, d = Math.random() * R;
      x.beginPath();
      x.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d, 1.2 + Math.random() * 2.6, 0, Math.PI * 2);
      x.fill();
    }
    const t = new THREE.CanvasTexture(c);
    return t;
  }

  function createSplatPool(scene, n) {
    n = n || 18;
    const texs = [splatTexture(0), splatTexture(1), splatTexture(2), splatTexture(3)];
    const items = [];
    for (let i = 0; i < n; i++) {
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({
          map: texs[i % texs.length], transparent: true, opacity: 0,
          depthWrite: false, side: THREE.DoubleSide, toneMapped: false
        })
      );
      m.visible = false;
      m.renderOrder = 3;
      scene.add(m);
      items.push({ mesh: m, life: 0, max: 1 });
    }
    let cur = 0;
    const up = new V3(0, 1, 0), alt = new V3(1, 0, 0);
    return {
      spawn(p, nx, ny, nz, size) {
        const it = items[cur % items.length]; cur++;
        const m = it.mesh;
        m.visible = true;
        m.position.set(p.x + nx * 0.06, p.y + ny * 0.06, p.z + nz * 0.06);
        const dir = new V3(nx, ny, nz);
        if (dir.lengthSq() < 1e-6) dir.set(0, 1, 0);
        m.lookAt(m.position.clone().add(dir));
        m.rotation.z = Math.random() * Math.PI * 2;
        const s = (size || 1) * (1.4 + Math.random() * 0.9);
        m.scale.set(s, s, s);
        m.material.opacity = 0.95;
        it.life = 0; it.max = 7 + Math.random() * 4;
      },
      update(dt) {
        for (let i = 0; i < items.length; i++) {
          const it = items[i];
          if (!it.mesh.visible) continue;
          it.life += dt;
          const k = it.life / it.max;
          if (k >= 1) { it.mesh.visible = false; continue; }
          it.mesh.material.opacity = 0.95 * Math.min(1, (1 - k) * 3);
        }
      }
    };
  }

  /* ------------------------------------------------------ 임팩트 파티클 */
  function createSparks(scene, n) {
    n = n || 60;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(n * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      size: 0.5, color: 0xffffff, transparent: true, opacity: 0.9,
      depthWrite: false, toneMapped: false
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    scene.add(pts);
    const vel = [];
    const life = new Float32Array(n);
    for (let i = 0; i < n; i++) { vel.push(new V3()); life[i] = 0; pos[i * 3 + 1] = -9999; }
    let cur = 0;
    return {
      burst(p, count, spread, speed) {
        for (let i = 0; i < count; i++) {
          const k = cur % n; cur++;
          pos[k * 3] = p.x; pos[k * 3 + 1] = p.y; pos[k * 3 + 2] = p.z;
          vel[k].set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5)
            .normalize().multiplyScalar(speed * (0.4 + Math.random()) * spread);
          life[k] = 0.5 + Math.random() * 0.4;
        }
      },
      update(dt) {
        let any = false;
        for (let i = 0; i < n; i++) {
          if (life[i] <= 0) continue;
          any = true;
          life[i] -= dt;
          vel[i].y -= 22 * dt;
          pos[i * 3] += vel[i].x * dt;
          pos[i * 3 + 1] += vel[i].y * dt;
          pos[i * 3 + 2] += vel[i].z * dt;
          if (life[i] <= 0) pos[i * 3 + 1] = -9999;
        }
        if (any) geo.attributes.position.needsUpdate = true;
      }
    };
  }

  NS.Web = { createStrand, createSplatPool, createSparks };
})();
