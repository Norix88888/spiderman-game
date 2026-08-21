/* =========================================================================
   player.js — 스파이더맨 컨트롤러
   지상 이동 / 점프 / 진자 스윙 / 웹 짚 / 벽 붙기 / 다이브 + 3인칭 카메라
   ========================================================================= */
(function () {
  const NS = (window.SPIDER = window.SPIDER || {});
  const V3 = THREE.Vector3;
  const C = {
    GRAV: 24,
    RUN: 9.5, SPRINT: 17.5,
    ACC_G: 60, ACC_A: 18,
    JUMP: 12.5,
    JUMP_HOLD: 26,        // 점프 키를 길게 누르면 더 높이 (가변 점프)
    JUMP_HOLD_T: 0.3,
    MAXSPD: 84,
    ROPE_MIN: 9, ROPE_MAX: 105,
    REEL: 16,
    PUMP: 26,
    AUTO_PUMP: 7,         // 하강 중 자동으로 줄을 당겨 진자에 에너지를 넣는다
    ZIP_SPEED: 62,
    PL_UP: 9, PL_ARC: 12, // 포인트 런치 (스윙 최저점에서 점프)
    WALLRUN: 12,
    R: 0.42
  };

  const hit = { x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, dist: 0, box: null };
  const hit2 = { x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, dist: 0, box: null };
  const idxBuf = [];

  const _f = new V3(), _r = new V3(), _w = new V3(), _n = new V3(), _t = new V3(),
    _a = new V3(), _b = new V3(), _c = new V3(), _up = new V3(0, 1, 0),
    _m = new THREE.Matrix4(), _q = new THREE.Quaternion();

  function orient(q, fwd, up) {
    _b.copy(fwd).normalize();
    _c.copy(up).addScaledVector(_b, -up.dot(_b));
    if (_c.lengthSq() < 1e-6) _c.set(0, 1, 0).addScaledVector(_b, -_b.y);
    _c.normalize();
    _a.crossVectors(_c, _b);            // x = y × z  (모델은 +Z 정면)
    _m.makeBasis(_a, _c, _b);
    q.setFromRotationMatrix(_m);
    return q;
  }

  function create(scene, city, suitId) {
    let rig = NS.Character.build(suitId);
    scene.add(rig.root);

    const strand = NS.Web.createStrand(scene, { radius: 0.058 });
    const strand2 = NS.Web.createStrand(scene, { radius: 0.045 });
    const splats = NS.Web.createSplatPool(scene, 18);
    const sparks = NS.Web.createSparks(scene, 90);

    const p = {
      rig, scene, city, strand, strand2, splats, sparks,
      pos: new V3(0, 160, 0),
      vel: new V3(0, 0, 0),
      state: 'air',
      grounded: false,
      wallN: new V3(),
      time: 0,
      cycle: 0,
      yaw: 0,
      camYaw: 0, camPitch: 0.12,
      camPos: new V3(0, 165, -10),
      camLook: new V3(),
      camDist: 7.2,
      roll: 0,
      web: { on: false, anchor: new V3(), len: 20, side: 'R', t: 0, grow: 0, tension: 1 },
      zip: { on: false, target: new V3(), t: 0 },
      landCool: 0,
      airTime: 0,
      jumpHold: 0, wallRunT: 0, pointLaunch: 0,
      speedKmh: 0,
      best: 0,
      lastAnchorMiss: 0,
      suitId: suitId
    };

    p.targetQuat = new THREE.Quaternion();
    p.rig.root.position.copy(p.pos);

    /* -------------------------------------------------- 슈트 교체 */
    p.setSuit = function (id) {
      scene.remove(rig.root);
      const nr = NS.Character.build(id);
      nr.root.position.copy(p.rig.root.position);
      nr.root.quaternion.copy(p.rig.root.quaternion);
      scene.add(nr.root);
      p.rig = rig = nr;
      p.suitId = id;
    };

    /* -------------------------------------------------- 부착점 탐색 */
    const YAWS = [0, 0.26, -0.26, 0.52, -0.52, 0.8, -0.8];
    const PITCHES = [0.85, 0.62, 1.1, 0.42];

    /* 빠르게 날고 있으면 카메라가 아니라 '진행 방향' 기준으로 부착점을 찾는다.
       (PS 스파이더맨처럼 시선을 돌려도 스윙 흐름이 안 끊기게) */
    function aimYaw() {
      const hs = Math.hypot(p.vel.x, p.vel.z);
      if (hs < 12) return p.camYaw;
      let d = Math.atan2(p.vel.x, p.vel.z) - p.camYaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      return p.camYaw + d * Math.min(0.6, (hs - 12) / 40);
    }

    function findAnchor(origin, camYaw, out) {
      let bestScore = -1e9, found = false;
      for (let pi = 0; pi < PITCHES.length; pi++) {
        const pitch = PITCHES[pi];
        for (let yi = 0; yi < YAWS.length; yi++) {
          const yaw = camYaw + YAWS[yi];
          const ch = Math.cos(pitch);
          const dx = Math.sin(yaw) * ch, dy = Math.sin(pitch), dz = Math.cos(yaw) * ch;
          if (!NS.City.raycast(city, origin.x, origin.y, origin.z, dx, dy, dz, C.ROPE_MAX, hit2)) continue;
          if (hit2.y < origin.y + 5) continue;
          const d = hit2.dist;
          if (d < 12) continue;
          // 이 줄로 스윙하면 호의 최저점이 어디인가 → 바닥에 처박히는 부착점은 감점
          const lowPoint = hit2.y - d;
          let s = -Math.abs(d - 48) * 0.55
            - Math.abs(YAWS[yi]) * 26
            - Math.abs(pitch - 0.8) * 14
            + (hit2.y - origin.y) * 0.28;
          if (lowPoint < 14) s -= (14 - lowPoint) * 2.2;
          // 옥상(위를 향한 면)에 걸면 그 건물을 넘어가며 탈 수 있다.
          // 벽면에 걸면 호가 그 벽을 파고들어 갈려버린다 → 크게 선호
          if (hit2.ny > 0.5) s += 34;
          if (s > bestScore) {
            bestScore = s; found = true;
            out.set(hit2.x, hit2.y, hit2.z);
            out.userNx = hit2.nx; out.userNy = hit2.ny; out.userNz = hit2.nz;
          }
        }
      }
      return found;
    }

    /* -------------------------------------------------- 웹 발사 */
    function fireWeb() {
      _a.copy(p.pos); _a.y += 1.5;
      if (findAnchor(_a, aimYaw(), _b)) {
        p.web.on = true;
        p.web.anchor.copy(_b);
        p.web.len = Math.max(C.ROPE_MIN, _a.distanceTo(_b));
        p.web.t = 0; p.web.grow = 0;
        p.web.side = (p.web.anchor.x - p.pos.x) * Math.cos(p.camYaw)
          - (p.web.anchor.z - p.pos.z) * Math.sin(p.camYaw) > 0 ? 'L' : 'R';
        p.state = 'swing';
        splats.spawn(p.web.anchor, _b.userNx || 0, _b.userNy || 1, _b.userNz || 0, 1);
        if (NS.sfx) NS.sfx.thwip();
        return true;
      }
      p.lastAnchorMiss = 0.4;
      if (NS.sfx) NS.sfx.miss();
      return false;
    }
    function releaseWeb(boost) {
      if (!p.web.on) return;
      p.web.on = false;
      strand.hide();
      if (boost) {
        if (p.vel.y > 0) p.vel.y = Math.min(p.vel.y * 1.06, p.vel.y + 2.5);
        p.vel.multiplyScalar(1.03);
      }
      if (p.state === 'swing') p.state = 'air';
    }

    function fireZip(camYaw, camPitch) {
      _a.copy(p.pos); _a.y += 1.5;
      const ch = Math.cos(camPitch);
      const dx = Math.sin(camYaw) * ch, dy = Math.sin(camPitch), dz = Math.cos(camYaw) * ch;
      if (NS.City.raycast(city, _a.x, _a.y, _a.z, dx, dy, dz, 150, hit)) {
        p.zip.on = true;
        p.zip.target.set(hit.x, hit.y, hit.z);
        p.zip.t = 0;
        p.state = 'zip';
        releaseWeb(false);
        splats.spawn(p.zip.target, hit.nx, hit.ny, hit.nz, 0.8);
        if (NS.sfx) NS.sfx.thwip(1.25);
        return true;
      }
      if (NS.sfx) NS.sfx.miss();
      return false;
    }

    /* -------------------------------------------------- 충돌 */
    const SPH = [0.45, 1.35];
    function collide(dt) {
      let ground = false, wall = false;
      _n.set(0, 0, 0);
      NS.City.nearBoxes(city, p.pos.x, p.pos.z, 4, idxBuf);
      for (let pass = 0; pass < 2; pass++) {
        for (let i = 0; i < idxBuf.length; i++) {
          const b = city.boxes[idxBuf[i]];
          for (let s = 0; s < SPH.length; s++) {
            const cy = p.pos.y + SPH[s];
            const qx = Math.max(b.x0, Math.min(p.pos.x, b.x1));
            const qy = Math.max(b.y0, Math.min(cy, b.y1));
            const qz = Math.max(b.z0, Math.min(p.pos.z, b.z1));
            let dx = p.pos.x - qx, dy = cy - qy, dz = p.pos.z - qz;
            let d2 = dx * dx + dy * dy + dz * dz;
            if (d2 >= C.R * C.R) continue;
            let nx, ny, nz, pen;
            if (d2 > 1e-8) {
              const d = Math.sqrt(d2);
              nx = dx / d; ny = dy / d; nz = dz / d; pen = C.R - d;
            } else {
              // 내부 깊숙이 → 최소 축으로 밀어냄
              const ex = Math.min(p.pos.x - b.x0, b.x1 - p.pos.x);
              const ey = Math.min(cy - b.y0, b.y1 - cy);
              const ez = Math.min(p.pos.z - b.z0, b.z1 - p.pos.z);
              if (ey <= ex && ey <= ez) { nx = 0; ny = (cy - (b.y0 + b.y1) / 2) > 0 ? 1 : -1; nz = 0; pen = ey + C.R; }
              else if (ex <= ez) { nx = (p.pos.x - (b.x0 + b.x1) / 2) > 0 ? 1 : -1; ny = 0; nz = 0; pen = ex + C.R; }
              else { nx = 0; ny = 0; nz = (p.pos.z - (b.z0 + b.z1) / 2) > 0 ? 1 : -1; pen = ez + C.R; }
            }
            p.pos.x += nx * pen; p.pos.y += ny * pen; p.pos.z += nz * pen;
            const vn = p.vel.x * nx + p.vel.y * ny + p.vel.z * nz;
            if (vn < 0) { p.vel.x -= nx * vn; p.vel.y -= ny * vn; p.vel.z -= nz * vn; }
            if (ny > 0.7) ground = true;
            else if (Math.abs(ny) < 0.6) { wall = true; _n.set(nx, 0, nz).normalize(); }
          }
        }
      }
      if (p.pos.y < 0) { p.pos.y = 0; if (p.vel.y < 0) p.vel.y = 0; ground = true; }
      return { ground, wall, normal: _n };
    }

    function groundProbe() {
      if (NS.City.raycast(city, p.pos.x, p.pos.y + 0.4, p.pos.z, 0, -1, 0, 1.0, hit)) {
        if (hit.dist < 0.55 && p.vel.y <= 0.6) {
          p.pos.y = hit.y;
          if (p.vel.y < 0) p.vel.y = 0;
          return true;
        }
      }
      return false;
    }

    /* -------------------------------------------------- 메인 업데이트 */
    p.update = function (dt, input) {
      p.time += dt;
      if (p.lastAnchorMiss > 0) p.lastAnchorMiss -= dt;
      if (p.pointLaunch > 0) p.pointLaunch -= dt;

      // 카메라 각도
      p.camYaw -= input.mouseX * 0.0024;
      p.camPitch -= input.mouseY * 0.0024;
      p.camPitch = Math.max(-1.15, Math.min(1.0, p.camPitch));

      const cy = Math.cos(p.camYaw), sy = Math.sin(p.camYaw);
      _f.set(sy, 0, cy);
      _r.set(-cy, 0, sy);
      _w.set(0, 0, 0)
        .addScaledVector(_f, input.moveZ)
        .addScaledVector(_r, input.moveX);
      const hasInput = _w.lengthSq() > 0.001;
      if (hasInput) _w.normalize();

      /* ---- 입력 → 액션 ---- */
      if (input.swingPressed && !p.web.on && p.state !== 'zip') fireWeb();
      if (!input.swingHeld && p.web.on) releaseWeb(true);
      if (input.zipPressed) {
        // 조준선에 범인이 있으면 포박용 웹샷, 없으면 웹 짚으로 이동
        if (!(p.onWebFire && p.onWebFire())) fireZip(p.camYaw, p.camPitch);
      }

      /* ---- 상태별 물리 ---- */
      if (p.state === 'zip') {
        p.zip.t += dt;
        _a.subVectors(p.zip.target, p.pos); _a.y -= 1.2;
        const d = _a.length();
        _a.normalize();
        const sp = Math.min(C.ZIP_SPEED, 18 + p.zip.t * 130);
        p.vel.lerp(_a.multiplyScalar(sp), 1 - Math.exp(-9 * dt));
        p.vel.y += 3 * dt;
        if (d < 3.2 || p.zip.t > 2.6) {
          p.zip.on = false;
          p.state = 'air';
          p.vel.multiplyScalar(0.62);
          p.vel.y = Math.max(p.vel.y, 6);
          sparks.burst(p.zip.target, 10, 1, 6);
        }
        strand2.show();
      } else if (p.state === 'wall') {
        // 벽 크롤
        _a.copy(p.wallN);
        _b.set(0, 1, 0).addScaledVector(_a, -_a.y).normalize();   // 벽면상의 위쪽
        _c.crossVectors(_b, _a).normalize();                       // 벽면상의 오른쪽
        const climbUp = input.moveZ, climbSide = input.moveX;
        // 벽 달리기: 위로 오를 땐 확실히 빠르게 (PS 스파이더맨의 월러너)
        const sp = (input.sprint ? C.WALLRUN : 7) * (climbUp > 0 ? 1.25 : 1);
        p.wallRunT = climbUp > 0 ? Math.min(1.6, (p.wallRunT || 0) + dt)
          : Math.max(0, (p.wallRunT || 0) - dt * 1.4);
        // 입력이 만드는 목표 속도
        _t.set(0, 0, 0)
          .addScaledVector(_b, climbUp * sp * (1 + p.wallRunT * 0.35))
          .addScaledVector(_c, -climbSide * sp);
        // 붙기 직전의 운동량을 바로 죽이지 않고 서서히 목표 속도로 수렴시킨다
        p.vel.lerp(_t, 1 - Math.exp(-5 * dt));
        p.vel.addScaledVector(_a, -2.5);      // 벽에 붙어있게
        p.pos.addScaledVector(p.vel, dt);
        if (input.jump) {
          // 벽차기: 오래 달려 올랐을수록 더 멀리 튕겨 나간다
          const boost = 1 + (p.wallRunT || 0) * 0.5;
          p.vel.copy(_a).multiplyScalar(13 * boost);
          p.vel.y += 13 * boost;
          p.wallRunT = 0;
          p.jumpHold = C.JUMP_HOLD_T;
          p.state = 'air';
          if (NS.sfx) NS.sfx.jump();
        }
        if (input.swingPressed) { if (fireWeb()) { /* 스윙 전환 */ } }
        // 옥상 넘어가기
        if (!NS.City.raycast(city, p.pos.x, p.pos.y + 1.6, p.pos.z, -_a.x, -_a.y, -_a.z, 1.4, hit)) {
          p.pos.addScaledVector(_a, -0.6);
          p.pos.y += 0.8;
          p.state = 'air';
          p.vel.set(0, 2, 0).addScaledVector(_b, 4);
        }
      } else {
        // 중력
        const g = p.state === 'swing' ? C.GRAV * 0.92 : C.GRAV;
        p.vel.y -= g * dt;

        if (p.state === 'swing' && p.web.on) {
          p.web.t += dt;
          p.web.grow = Math.min(1, p.web.t / 0.075);
          // 줄 길이 조절
          if (input.moveZ > 0.1) p.web.len = Math.max(C.ROPE_MIN, p.web.len - C.REEL * dt);
          else if (input.moveZ < -0.1) p.web.len = Math.min(C.ROPE_MAX, p.web.len + C.REEL * 0.8 * dt);
          // 자동 펌핑: 줄 길이를 건드리면 진자가 아니라 윈치가 되어 속도를 잃는다.
          // 그래서 '하강 중 접선 방향 가속'으로 에너지를 넣는다(실제 그네 타기와 같은 효과).
          if (p.vel.y < -1) {
            _t.copy(p.vel);
            const L = _t.length();
            if (L > 2) {
              _t.multiplyScalar(1 / L);
              p.vel.addScaledVector(_t, C.AUTO_PUMP * dt);
            }
          }
          // 좌우 조향
          p.vel.addScaledVector(_r, input.moveX * 22 * dt);
          // 펌핑 가속
          if (input.moveZ > 0.1 || input.sprint) {
            _t.copy(p.vel); _t.y = 0;
            if (_t.lengthSq() > 1) {
              _t.normalize();
              p.vel.addScaledVector(_t, C.PUMP * dt);
            }
          }
          // ---- 포인트 런치: 스윙 중 점프. 호의 최저점에 가까울수록 크게 솟는다 ----
          if (input.jump) {
            _a.subVectors(p.pos, p.web.anchor);
            const L = _a.length() || 1;
            const under = Math.max(0, -_a.y / L);      // 앵커 바로 아래면 1
            releaseWeb(false);
            p.vel.y = Math.max(p.vel.y, 0) + C.PL_UP + under * C.PL_ARC;
            const hs = Math.hypot(p.vel.x, p.vel.z);
            if (hs > 1) {
              const k = 1 + under * 0.22;
              p.vel.x *= k; p.vel.z *= k;
            }
            p.pointLaunch = 0.45;
            p.state = 'air';
            if (NS.sfx) NS.sfx.jump();
          }
        } else {
          // 공중 제어
          if (hasInput) p.vel.addScaledVector(_w, (p.grounded ? C.ACC_G : C.ACC_A) * dt);
        }

        if (p.grounded && p.state !== 'swing') {
          // 지상 마찰 + 최대속도
          const maxS = input.sprint ? C.SPRINT : C.RUN;
          _t.set(p.vel.x, 0, p.vel.z);
          const hs = _t.length();
          if (hs > maxS) { _t.multiplyScalar(maxS / hs); p.vel.x = _t.x; p.vel.z = _t.z; }
          if (!hasInput) {
            const f = Math.exp(-9 * dt);
            p.vel.x *= f; p.vel.z *= f;
          }
          if (input.jump) {
            p.vel.y = C.JUMP * (input.sprint ? 1.15 : 1);
            p.grounded = false;
            p.state = 'air';
            p.jumpHold = C.JUMP_HOLD_T;
            if (NS.sfx) NS.sfx.jump();
          }
        }

        // 가변 점프 높이 — 누르고 있는 동안 조금 더 솟는다
        if (p.jumpHold > 0) {
          if (input.jumpHeld && p.vel.y > 0) {
            p.vel.y += C.JUMP_HOLD * dt;
            p.jumpHold -= dt;
          } else p.jumpHold = 0;
        }

        // 다이브(공중 Shift): 급강하 가속
        if (!p.grounded && p.state !== 'swing' && input.sprint && p.vel.y < 6) {
          _t.copy(_f).multiplyScalar(30 * dt);
          p.vel.add(_t);
          p.vel.y -= 16 * dt;
        }

        // 적분
        p.pos.addScaledVector(p.vel, dt);

        // 로프 구속
        if (p.web.on && p.web.grow >= 1) {
          _a.subVectors(p.pos, p.web.anchor);
          const dist = _a.length();
          if (dist > p.web.len) {
            _a.multiplyScalar(1 / dist);
            p.pos.copy(p.web.anchor).addScaledVector(_a, p.web.len);
            const radial = p.vel.dot(_a);
            if (radial > 0) p.vel.addScaledVector(_a, -radial * 1.0);
          }
          p.web.tension = Math.min(1, dist / p.web.len);
          // 너무 가까워지면 자동으로 놓음
          if (dist < C.ROPE_MIN * 0.75) releaseWeb(false);
        }
      }

      // 최대 속도
      const sp2 = p.vel.length();
      if (sp2 > C.MAXSPD) p.vel.multiplyScalar(C.MAXSPD / sp2);

      /* ---- 충돌 ---- */
      const col = collide(dt);
      const wasGround = p.grounded;
      p.grounded = col.ground || groundProbe();

      if (p.grounded) {
        if (!wasGround && p.state !== 'ground') {
          const impact = Math.abs(p.vel.y) + p.airTime * 2;
          if (p.airTime > 0.55) {
            rig.landTimer = 0.42;
            sparks.burst(p.pos, 12, 1, 5);
            if (NS.sfx) NS.sfx.land(Math.min(1, p.airTime / 2));
          }
        }
        p.airTime = 0;
        if (p.state !== 'swing') p.state = 'ground';
        releaseWeb(false);
      } else {
        p.airTime += dt;
        if (p.state === 'ground') p.state = 'air';
        // 스윙 중 벽에 갈리면 줄을 놓는다 (안 그러면 벽에 붙어 속도가 0이 된다)
        if (col.wall && p.state === 'swing' && p.web.on) releaseWeb(false);
        // 벽 붙기
        if (col.wall && p.state !== 'zip' && p.pos.y > 2.5 && !p.web.on) {
          const into = -(p.vel.x * col.normal.x + p.vel.z * col.normal.z);
          if (into > -2) {
            p.wallN.copy(col.normal);
            p.state = 'wall';
            // 속도를 죽이지 않고 벽면에 투영해 보존 → 그대로 벽을 타고 달린다
            const vn = p.vel.dot(p.wallN);
            p.vel.addScaledVector(p.wallN, -vn);
            p.vel.multiplyScalar(0.78);
            p.wallRunT = Math.min(1.2, p.vel.length() / 30);
            sparks.burst(p.pos, 6, 0.6, 3);
            if (NS.sfx) NS.sfx.stick();
          }
        }
      }

      // 도시 밖으로 못 나가게
      const L = city.HALF + 60;
      p.pos.x = Math.max(-L, Math.min(L, p.pos.x));
      p.pos.z = Math.max(-L, Math.min(L, p.pos.z));

      p.speedKmh = p.vel.length() * 3.6;
      if (p.speedKmh > p.best) p.best = p.speedKmh;

      /* ---- 모델 방향 ---- */
      let poseMode = 'idle';
      const hspeed = Math.hypot(p.vel.x, p.vel.z);
      if (p.state === 'swing') {
        poseMode = 'swing';
        _a.copy(p.vel).normalize();
        _b.subVectors(p.web.anchor, p.pos).normalize();
        if (_a.lengthSq() < 0.1) _a.set(_f.x, 0, _f.z);
        orient(p.targetQuat, _a, _b);
      } else if (p.state === 'wall') {
        poseMode = 'wall';
        _b.set(0, 1, 0).addScaledVector(p.wallN, -p.wallN.y).normalize();
        _a.copy(p.wallN).multiplyScalar(-1);
        orient(p.targetQuat, _a, _b);
      } else if (p.state === 'zip') {
        poseMode = 'dive';
        _a.copy(p.vel).normalize();
        orient(p.targetQuat, _a, _up);
      } else if (!p.grounded) {
        if (input.sprint && p.vel.y < 4) {
          poseMode = 'dive';
          _a.copy(p.vel).normalize();
          orient(p.targetQuat, _a, _up);
        } else {
          poseMode = 'air';
          _a.set(p.vel.x, 0, p.vel.z);
          if (_a.lengthSq() < 0.5) _a.copy(_f);
          orient(p.targetQuat, _a.normalize(), _up);
        }
      } else {
        poseMode = hspeed > 0.6 ? 'run' : 'idle';
        _a.set(p.vel.x, 0, p.vel.z);
        if (_a.lengthSq() < 0.4) _a.copy(_f);
        orient(p.targetQuat, _a.normalize(), _up);
      }
      rig.root.position.copy(p.pos);
      rig.root.quaternion.slerp(p.targetQuat, 1 - Math.exp(-9 * dt));

      /* ---- 포즈 ---- */
      p.cycle += dt * (2.2 + hspeed * 0.62);
      NS.Character.update(rig, {
        mode: poseMode, time: p.time, cycle: p.cycle,
        speed: hspeed, vy: p.vel.y,
        moving: Math.abs(input.moveX) + Math.abs(input.moveZ) > 0.1,
        snap: poseMode === 'run' ? 20 : 13
      }, dt);

      rig.root.updateMatrixWorld(true);

      /* ---- 거미줄 렌더 ---- */
      if (p.web.on) {
        NS.Character.aimArm(rig, p.web.side, p.web.anchor, -0.35);
        rig.root.updateMatrixWorld(true);
        NS.Character.handWorld(rig, p.web.side, _a);
        strand.show();
        strand.update(_a, p.web.anchor, p.web.tension, p.time, p.web.grow);
      } else if (strand.visible) strand.hide();

      if (p.state === 'zip') {
        const side = 'R';
        NS.Character.aimArm(rig, side, p.zip.target, -0.2);
        rig.root.updateMatrixWorld(true);
        NS.Character.handWorld(rig, side, _a);
        strand2.show();
        strand2.update(_a, p.zip.target, 1, p.time, Math.min(1, p.zip.t / 0.06));
      } else if (strand2.visible) strand2.hide();

      splats.update(dt);
      sparks.update(dt);
    };

    /* -------------------------------------------------- 카메라 */
    p.updateCamera = function (camera, dt) {
      const cp = Math.cos(p.camPitch), sp = Math.sin(p.camPitch);
      _f.set(Math.sin(p.camYaw) * cp, sp, Math.cos(p.camYaw) * cp).normalize();

      const speed = p.vel.length();
      let dist = 6.4 + Math.min(4.2, speed * 0.11);
      if (p.state === 'swing' || p.state === 'zip') dist += 1.6;

      _a.copy(p.pos);
      _a.y += 1.55;
      _a.addScaledVector(p.vel, 0.045);      // 진행방향 살짝 앞을 봄

      // 카메라가 벽을 뚫지 않도록
      _b.copy(_f).multiplyScalar(-1);
      if (NS.City.raycast(city, _a.x, _a.y, _a.z, _b.x, _b.y, _b.z, dist + 0.7, hit)) {
        dist = Math.max(1.6, hit.dist - 0.55);
      }
      p.camDist += (dist - p.camDist) * (1 - Math.exp(-10 * dt));

      _c.copy(_a).addScaledVector(_f, -p.camDist);
      const k = 1 - Math.exp(-(p.state === 'swing' ? 13 : 16) * dt);
      p.camPos.lerp(_c, k);
      p.camLook.lerp(_a, 1 - Math.exp(-20 * dt));

      camera.position.copy(p.camPos);
      camera.up.set(0, 1, 0);
      camera.lookAt(p.camLook);

      // 스윙 뱅킹
      let targetRoll = 0;
      if (p.state === 'swing') {
        _t.subVectors(p.web.anchor, p.pos).normalize();
        _r.set(-Math.cos(p.camYaw), 0, Math.sin(p.camYaw));
        targetRoll = -_t.dot(_r) * 0.42;
      }
      p.roll += (targetRoll - p.roll) * (1 - Math.exp(-6 * dt));
      camera.rotateZ(p.roll);

      // 속도감 FOV
      const fov = 60 + Math.min(30, speed * 0.62) + (p.state === 'zip' ? 8 : 0);
      if (Math.abs(camera.fov - fov) > 0.05) {
        camera.fov += (fov - camera.fov) * (1 - Math.exp(-5 * dt));
        camera.updateProjectionMatrix();
      }
    };

    p.respawn = function () {
      p.pos.set(0, 200, 0);
      p.vel.set(0, 0, 0);
      p.state = 'air';
      releaseWeb(false);
      p.zip.on = false;
    };

    p.stateLabel = function () {
      switch (p.state) {
        case 'swing': return '스윙';
        case 'wall': return '벽 붙기';
        case 'zip': return '웹 짚';
        case 'air': return p.vel.y < -12 ? '급강하' : '공중';
        default: return '지상';
      }
    };

    return p;
  }

  NS.Player = { create, C };
})();
