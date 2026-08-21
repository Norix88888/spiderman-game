/* =========================================================================
   crime.js — 범죄 저지 시스템
   도시 곳곳에서 범죄가 발생하고, 거미줄을 쏴서 범인을 포박(체포)한다.
   · 도둑: 도망친다. 웹 2발이면 포박
   · 깡패: 달려들어 주먹질. 웹 3발
   · 총잡이: 거리를 두고 사격. 웹 3발
   ========================================================================= */
(function () {
  const NS = (window.SPIDER = window.SPIDER || {});
  const V3 = THREE.Vector3;
  const BGU = THREE.BufferGeometryUtils || window.BufferGeometryUtils;

  const CFG = {
    SITES: 4,             // 동시에 활성화되는 범죄 현장 수
    PER_SITE: [2, 4],     // 현장당 범인 수
    AGGRO: 42,            // 스파이더맨을 인지하는 거리
    ATTACK: 2.6,          // 근접 공격 사거리
    SHOOT: 26,            // 총잡이 사거리
    WEB_RANGE: 85,        // 웹샷 사거리
    WEB_CONE: 0.30,       // 조준 허용 각(코사인 아님, 라디안)
    ARREST_SCORE: 250,
    SITE_SCORE: 1000
  };

  const TYPES = {
    thief: { name: '도둑', hp: 2, speed: 7.2, color: 0x2c4a7a, hood: 0x1c2c4a, flee: true, ranged: false },
    thug: { name: '깡패', hp: 3, speed: 5.4, color: 0x3a2a2a, hood: 0x241818, flee: false, ranged: false },
    gunman: { name: '총잡이', hp: 3, speed: 4.2, color: 0x2a2a30, hood: 0x17171c, flee: false, ranged: true }
  };

  let seed = 987654321;
  function rnd() { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; }
  function rr(a, b) { return a + rnd() * (b - a); }

  /* ------------------------------------------------------------ 모델 */
  function capsule(r, len, seg) {
    const pts = [], cs = 4;
    for (let i = cs; i >= 0; i--) {
      const a = (Math.PI / 2) * (i / cs);
      pts.push(new THREE.Vector2(Math.max(0.001, Math.cos(a) * r), -len / 2 - Math.sin(a) * r * 0.8));
    }
    for (let i = 0; i <= cs; i++) {
      const a = (Math.PI / 2) * (i / cs);
      pts.push(new THREE.Vector2(Math.max(0.001, Math.cos(a) * r), len / 2 + Math.sin(a) * r * 0.8));
    }
    return new THREE.LatheGeometry(pts, seg || 10, -Math.PI, Math.PI * 2);
  }

  /* 지오메트리·재질은 타입별로 한 번만 만들어 재사용한다.
     (범인이 새로 생길 때마다 새로 만들면 그 순간 프레임이 멈춘다) */
  const GEO = {};
  const MAT = {};
  function geo(key, make) { return GEO[key] || (GEO[key] = make()); }
  function matsFor(type) {
    if (MAT[type]) return MAT[type];
    const T = TYPES[type];
    MAT[type] = {
      body: new THREE.MeshStandardMaterial({ color: T.color, roughness: 0.85, metalness: 0.05 }),
      hood: new THREE.MeshStandardMaterial({ color: T.hood, roughness: 0.9, metalness: 0.02 }),
      skin: new THREE.MeshStandardMaterial({ color: 0x9c7a5e, roughness: 0.75, metalness: 0 }),
      gun: new THREE.MeshStandardMaterial({ color: 0x15161c, roughness: 0.4, metalness: 0.8 })
    };
    return MAT[type];
  }

  function buildGoon(type) {
    const T = TYPES[type];
    const M = matsFor(type);
    const body = M.body, hood = M.hood, skin = M.skin;

    const root = new THREE.Group();
    const j = {};

    j.hips = new THREE.Object3D(); j.hips.position.y = 0.92; root.add(j.hips);

    const torso = new THREE.Mesh(geo('torso', () => capsule(0.19, 0.42)), body);
    torso.position.y = 0.2; torso.scale.z = 0.72; torso.castShadow = true;
    j.hips.add(torso);

    j.head = new THREE.Object3D(); j.head.position.y = 0.5; j.hips.add(j.head);
    const head = new THREE.Mesh(geo('head', () => new THREE.SphereGeometry(0.115, 12, 10)), skin);
    head.position.y = 0.09; j.head.add(head);
    const hd = new THREE.Mesh(geo('hood', () =>
      new THREE.SphereGeometry(0.15, 12, 10, 0, Math.PI * 2, 0, Math.PI * 0.6)), hood);
    hd.position.set(0, 0.09, -0.02); hd.scale.set(1, 1.1, 1.15); j.head.add(hd);

    ['L', 'R'].forEach(s => {
      const sg = s === 'L' ? 1 : -1;
      const sh = new THREE.Object3D(); sh.position.set(sg * 0.2, 0.38, 0); j.hips.add(sh);
      const ua = new THREE.Mesh(geo('ua', () => capsule(0.055, 0.26, 8)), body);
      ua.position.y = -0.13; sh.add(ua);
      const el = new THREE.Object3D(); el.position.y = -0.26; sh.add(el);
      const fa = new THREE.Mesh(geo('fa', () => capsule(0.048, 0.24, 8)), skin);
      fa.position.y = -0.12; el.add(fa);
      j['sh' + s] = sh; j['el' + s] = el;

      const hp = new THREE.Object3D(); hp.position.set(sg * 0.1, 0, 0); j.hips.add(hp);
      const th = new THREE.Mesh(geo('th', () => capsule(0.075, 0.4, 8)), body);
      th.position.y = -0.2; hp.add(th);
      const kn = new THREE.Object3D(); kn.position.y = -0.4; hp.add(kn);
      const sn = new THREE.Mesh(geo('sn', () => capsule(0.06, 0.36, 8)), body);
      sn.position.y = -0.18; kn.add(sn);
      const ft = new THREE.Mesh(geo('ft', () => new THREE.BoxGeometry(0.1, 0.07, 0.2)), hood);
      ft.position.set(0, -0.38, 0.05); kn.add(ft);
      j['hip' + s] = hp; j['knee' + s] = kn;
    });

    if (T.ranged) {   // 총
      const gun = new THREE.Mesh(geo('gun', () => new THREE.BoxGeometry(0.06, 0.09, 0.24)), M.gun);
      gun.position.set(0, -0.24, 0.08);
      j.elR.add(gun);
    }
    return { root, j };
  }

  /* 포박 코쿤 */
  let cocoonGeo = null, cocoonMat = null;
  function makeCocoon() {
    if (!cocoonGeo) {
      cocoonGeo = capsule(0.32, 0.85, 12);
      const c = document.createElement('canvas'); c.width = c.height = 128;
      const x = c.getContext('2d');
      x.fillStyle = '#e8ecf8'; x.fillRect(0, 0, 128, 128);
      for (let i = 0; i < 160; i++) {
        x.strokeStyle = 'rgba(150,160,190,' + (0.1 + Math.random() * 0.35) + ')';
        x.lineWidth = Math.random() * 2.4 + 0.4;
        x.beginPath();
        x.moveTo(Math.random() * 128, Math.random() * 128);
        x.quadraticCurveTo(Math.random() * 128, Math.random() * 128, Math.random() * 128, Math.random() * 128);
        x.stroke();
      }
      const t = new THREE.CanvasTexture(c);
      t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(2, 2);
      cocoonMat = new THREE.MeshStandardMaterial({
        map: t, color: 0xf2f5ff, roughness: 0.7, metalness: 0,
        emissive: 0x6a7ba8, emissiveIntensity: 0.22
      });
    }
    const m = new THREE.Mesh(cocoonGeo, cocoonMat);
    m.castShadow = true;
    m.visible = false;
    return m;
  }

  /* --------------------------------------------------------- 시스템 */
  function create(scene, city, player) {
    const HALF = city.HALF;
    const PITCH = NS.City.PITCH;

    const strand = NS.Web.createStrand(scene, { radius: 0.05 });
    let strandT = 0, strandFrom = new V3(), strandTo = new V3();

    /* 현장 표시 광선 */
    const beamGeo = new THREE.CylinderGeometry(0.9, 2.2, 150, 10, 1, true);
    const beamMat = new THREE.MeshBasicMaterial({
      color: 0xff2b3c, transparent: true, opacity: 0.10, side: THREE.BackSide,
      depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
      fog: true
    });

    const enemies = [];
    const sites = [];
    const ctrl = {
      score: 0, arrests: 0, totalCrimes: 0,
      hp: 100, maxHp: 100,
      combo: 1, comboTimer: 0,
      hurtFlash: 0, damageTimer: 0,
      sites, enemies,
      nearestSite: null, nearestDist: 0, message: ''
    };

    /* ---------------- 현장 생성 ---------------- */
    const CRIME_NAMES = ['은행 강도', '차량 절도', '노상 강도', '금고 털이', '무장 강도', '상점 습격'];

    function freeSpot() {
      // 도로 교차점 근처 (건물 안 아님)
      for (let tries = 0; tries < 40; tries++) {
        const gx = Math.floor(rr(1, NS.City.CFG.GRID));
        const gz = Math.floor(rr(1, NS.City.CFG.GRID));
        const x = -HALF + gx * PITCH + rr(-6, 6);
        const z = -HALF + gz * PITCH + rr(-6, 6);
        if (!inside(x, z)) return new V3(x, 0, z);
      }
      return new V3(rr(-HALF * 0.6, HALF * 0.6), 0, rr(-HALF * 0.6, HALF * 0.6));
    }

    const _idx = [];
    function inside(x, z) {
      NS.City.nearBoxes(city, x, z, 2, _idx);
      for (let i = 0; i < _idx.length; i++) {
        const b = city.boxes[_idx[i]];
        if (x > b.x0 - 1.2 && x < b.x1 + 1.2 && z > b.z0 - 1.2 && z < b.z1 + 1.2) return true;
      }
      return false;
    }

    function spawnSite() {
      const pos = freeSpot();
      const beam = new THREE.Mesh(beamGeo, beamMat);
      beam.position.set(pos.x, 75, pos.z);
      scene.add(beam);

      const site = {
        pos, beam, name: CRIME_NAMES[Math.floor(rnd() * CRIME_NAMES.length)],
        enemies: [], done: false, t: 0
      };
      const n = Math.floor(rr(CFG.PER_SITE[0], CFG.PER_SITE[1] + 0.99));
      for (let i = 0; i < n; i++) {
        const r = rnd();
        const type = r < 0.42 ? 'thief' : (r < 0.78 ? 'thug' : 'gunman');
        const e = spawnEnemy(type, pos.x + rr(-7, 7), pos.z + rr(-7, 7), site);
        site.enemies.push(e);
      }
      sites.push(site);
      ctrl.totalCrimes++;
      return site;
    }

    function spawnEnemy(type, x, z, site) {
      const T = TYPES[type];
      const g = buildGoon(type);
      g.root.position.set(x, 0, z);
      scene.add(g.root);
      const cocoon = makeCocoon();
      cocoon.position.set(x, 0.5, z);
      scene.add(cocoon);
      const e = {
        type, T, site, model: g, cocoon,
        pos: new V3(x, 0, z), vel: new V3(),
        yaw: rnd() * 6.28, webs: 0, arrested: false, dead: false,
        state: 'idle', t: rnd() * 6, cycle: rnd() * 6,
        atkCool: 0, wanderT: 0, wander: new V3(),
        webBlobs: []
      };
      // 거미줄 덩어리 (맞을 때마다 하나씩 보임)
      for (let i = 0; i < 3; i++) {
        const b = new THREE.Mesh(
          geo('blob' + i, () => new THREE.SphereGeometry(0.16 + i * 0.045, 8, 6)), cocoonMat);
        b.visible = false;
        b.scale.set(1.5, 1.1, 1.1);
        g.j.hips.add(b);
        b.position.set(rr(-0.1, 0.1), rr(0.05, 0.42), rr(-0.06, 0.14));
        e.webBlobs.push(b);
      }
      enemies.push(e);
      return e;
    }

    for (let i = 0; i < CFG.SITES; i++) spawnSite();

    /* ---------------- 웹샷 ---------------- */
    const _o = new V3(), _d = new V3(), _v = new V3(), _v2 = new V3();

    ctrl.aimTarget = function (maxDist) {
      _o.copy(player.pos); _o.y += 1.5;
      const cp = Math.cos(player.camPitch);
      _d.set(Math.sin(player.camYaw) * cp, Math.sin(player.camPitch), Math.cos(player.camYaw) * cp);
      let best = null, bestScore = 1e9;
      for (let i = 0; i < enemies.length; i++) {
        const e = enemies[i];
        if (e.arrested || e.dead) continue;
        _v.copy(e.pos); _v.y += 1.0; _v.sub(_o);
        const d = _v.length();
        if (d > (maxDist || CFG.WEB_RANGE)) continue;
        _v.multiplyScalar(1 / d);
        const ang = Math.acos(Math.max(-1, Math.min(1, _v.dot(_d))));
        if (ang > CFG.WEB_CONE) continue;
        const s = ang * 40 + d * 0.12;
        if (s < bestScore) { bestScore = s; best = e; }
      }
      return best;
    };

    /* 우클릭/웹샷 버튼에서 호출. 적을 맞혔으면 true */
    ctrl.tryWebShot = function () {
      const e = ctrl.aimTarget();
      if (!e) return false;
      hitEnemy(e);
      return true;
    };

    function hitEnemy(e) {
      e.webs++;
      e.state = 'hit';
      e.t = 0;
      if (e.webBlobs[e.webs - 1]) e.webBlobs[e.webs - 1].visible = true;

      // 손 → 적 거미줄 연출
      if (player.rig) {
        NS.Character.handWorld(player.rig, 'R', strandFrom);
      } else strandFrom.copy(player.pos);
      strandTo.copy(e.pos); strandTo.y += 1.0;
      strandT = 0.22;
      strand.show();

      if (NS.sfx) NS.sfx.thwip(1.15);
      player.sparks.burst(strandTo, 8, 0.8, 5);

      if (e.webs >= e.T.hp) arrest(e);
      else ctrl.flash('타격!  ' + e.T.name + ' ' + e.webs + '/' + e.T.hp, '#ffd166');
    }

    function arrest(e) {
      e.arrested = true;
      e.state = 'arrested';
      e.model.root.visible = false;
      e.cocoon.visible = true;
      e.cocoon.position.set(e.pos.x, e.pos.y + 0.55, e.pos.z);
      e.cocoon.rotation.set(rr(-0.4, 0.4), rnd() * 6.28, rr(1.2, 1.9));

      ctrl.arrests++;
      ctrl.comboTimer = 6;
      ctrl.combo = Math.min(8, ctrl.combo + 1);
      ctrl.score += CFG.ARREST_SCORE * ctrl.combo;
      if (NS.sfx) NS.sfx.pickup(1 + ctrl.combo * 0.05);
      player.sparks.burst(e.pos, 20, 1.2, 9);
      ctrl.flash('체포!  +' + (CFG.ARREST_SCORE * ctrl.combo), '#4fe6ff');

      const site = e.site;
      if (site && !site.done && site.enemies.every(x => x.arrested)) {
        site.done = true;
        ctrl.score += CFG.SITE_SCORE;
        ctrl.flash('범죄 저지!  ' + site.name + ' +' + CFG.SITE_SCORE, '#7dff9b');
        setTimeout(() => { closeSite(site); }, 3000);
      }
    }

    function closeSite(site) {
      scene.remove(site.beam);
      site.enemies.forEach(e => {
        scene.remove(e.model.root);
        scene.remove(e.cocoon);
        e.dead = true;
        const i = enemies.indexOf(e); if (i >= 0) enemies.splice(i, 1);
      });
      const i = sites.indexOf(site); if (i >= 0) sites.splice(i, 1);
      if (sites.length < CFG.SITES) spawnSite();
    }

    ctrl.flash = function (msg, color) {
      ctrl.message = msg; ctrl.messageColor = color || '#fff'; ctrl.messageT = 1.6;
    };

    function damage(amount) {
      if (ctrl.damageTimer > 0) return;
      ctrl.hp -= amount;
      ctrl.damageTimer = 0.55;
      ctrl.hurtFlash = 1;
      ctrl.combo = 1;
      if (NS.sfx) NS.sfx.land(0.4);
      if (ctrl.hp <= 0) {
        ctrl.hp = ctrl.maxHp;
        ctrl.score = Math.max(0, ctrl.score - 500);
        ctrl.flash('기절… 다시 일어섰다 (-500)', '#ff5566');
        player.respawn();
      }
    }
    ctrl.damage = damage;

    /* ---------------- 매 프레임 ---------------- */
    const _tmp = new V3();
    ctrl.update = function (dt, time) {
      if (ctrl.comboTimer > 0) { ctrl.comboTimer -= dt; if (ctrl.comboTimer <= 0) ctrl.combo = 1; }
      if (ctrl.damageTimer > 0) ctrl.damageTimer -= dt;
      if (ctrl.hurtFlash > 0) ctrl.hurtFlash = Math.max(0, ctrl.hurtFlash - dt * 1.8);
      if (ctrl.messageT > 0) ctrl.messageT -= dt;
      // 체력 재생
      if (ctrl.damageTimer <= -3) ctrl.hp = Math.min(ctrl.maxHp, ctrl.hp + 6 * dt);
      else if (ctrl.damageTimer <= 0) ctrl.damageTimer -= dt;

      // 웹 스트랜드 연출
      if (strandT > 0) {
        strandT -= dt;
        if (player.rig) NS.Character.handWorld(player.rig, 'R', strandFrom);
        strand.update(strandFrom, strandTo, 1, time, 1);
        if (strandT <= 0) strand.hide();
      }

      // 가장 가까운 현장
      let nd = 1e9, ns = null;
      for (let i = 0; i < sites.length; i++) {
        const s = sites[i];
        const d = Math.hypot(s.pos.x - player.pos.x, s.pos.z - player.pos.z);
        // 가까이 가면 광선을 끈다 (화면을 가득 채워 성능이 죽는 걸 방지)
        s.beam.visible = !s.done && d > 34 && d < 700;
        if (d < nd) { nd = d; ns = s; }
      }
      ctrl.nearestSite = ns; ctrl.nearestDist = nd;

      // 적 갱신
      for (let i = 0; i < enemies.length; i++) {
        updateEnemy(enemies[i], dt, time);
      }
    };

    function updateEnemy(e, dt, time) {
      if (e.dead) return;
      if (e.arrested) {
        // 코쿤이 바닥으로
        if (e.cocoon.position.y > 0.42) e.cocoon.position.y -= 6 * dt;
        return;
      }
      const dx = player.pos.x - e.pos.x, dz = player.pos.z - e.pos.z;
      const dy = player.pos.y - e.pos.y;
      const dist = Math.hypot(dx, dz);
      const far = dist > 150 || dy > 130;
      if (far) { e.model.root.visible = false; return; }
      e.model.root.visible = true;

      e.t += dt;
      const T = e.T;
      let moveX = 0, moveZ = 0, speed = 0;

      const aware = dist < CFG.AGGRO && dy < 40;
      if (e.state === 'hit') {
        if (e.t > 0.45) e.state = aware ? 'alert' : 'idle';
        speed = 0;
      } else if (aware) {
        e.state = 'alert';
        if (T.flee) {                    // 도둑: 도망
          moveX = -dx / dist; moveZ = -dz / dist; speed = T.speed;
        } else if (T.ranged) {           // 총잡이: 거리 유지 + 사격
          if (dist < CFG.SHOOT * 0.55) { moveX = -dx / dist; moveZ = -dz / dist; speed = T.speed; }
          else if (dist > CFG.SHOOT) { moveX = dx / dist; moveZ = dz / dist; speed = T.speed; }
          e.atkCool -= dt;
          if (dist < CFG.SHOOT && e.atkCool <= 0 && Math.abs(dy) < 14) {
            e.atkCool = 1.6;
            player.sparks.burst(_tmp.set(e.pos.x, e.pos.y + 1.2, e.pos.z), 4, 0.4, 10);
            if (dist < CFG.SHOOT * 0.9) damage(7);
          }
        } else {                          // 깡패: 돌진
          if (dist > CFG.ATTACK) { moveX = dx / dist; moveZ = dz / dist; speed = T.speed; }
          else {
            e.atkCool -= dt;
            if (e.atkCool <= 0 && Math.abs(dy) < 2.2) {
              e.atkCool = 1.1;
              damage(10);
              player.vel.x -= (dx / dist) * 6;
              player.vel.z -= (dz / dist) * 6;
              player.vel.y += 3;
            }
          }
        }
      } else {
        e.state = 'idle';
        e.wanderT -= dt;
        if (e.wanderT <= 0) {
          e.wanderT = rr(1.6, 4);
          const a = rnd() * 6.28;
          e.wander.set(Math.cos(a), 0, Math.sin(a));
        }
        if (e.site) {
          const sd = Math.hypot(e.site.pos.x - e.pos.x, e.site.pos.z - e.pos.z);
          if (sd > 14) {
            e.wander.set((e.site.pos.x - e.pos.x) / sd, 0, (e.site.pos.z - e.pos.z) / sd);
          }
        }
        moveX = e.wander.x; moveZ = e.wander.z; speed = 1.9;
      }

      if (speed > 0) {
        const nx = e.pos.x + moveX * speed * dt;
        const nz = e.pos.z + moveZ * speed * dt;
        if (!inside(nx, nz)) { e.pos.x = nx; e.pos.z = nz; }
        else { e.wanderT = 0; }
        e.pos.x = Math.max(-HALF, Math.min(HALF, e.pos.x));
        e.pos.z = Math.max(-HALF, Math.min(HALF, e.pos.z));
        e.yaw = Math.atan2(moveX, moveZ);
        e.cycle += dt * (4 + speed * 1.1);
      } else {
        if (aware) e.yaw = Math.atan2(dx, dz);
        e.cycle += dt * 1.4;
      }

      e.model.root.position.set(e.pos.x, e.pos.y, e.pos.z);
      e.model.root.rotation.y = e.yaw;

      // 걷기 애니메이션
      const j = e.model.j;
      const w = speed > 0.2 ? Math.sin(e.cycle) : Math.sin(e.t * 1.5) * 0.12;
      const amp = speed > 0.2 ? 0.5 + speed * 0.05 : 0.1;
      j.hipL.rotation.x = w * amp;
      j.hipR.rotation.x = -w * amp;
      j.kneeL.rotation.x = -Math.max(0, -w) * 1.0 - 0.1;
      j.kneeR.rotation.x = -Math.max(0, w) * 1.0 - 0.1;
      j.shL.rotation.x = -w * amp * 0.8;
      j.shR.rotation.x = w * amp * 0.8;
      j.elL.rotation.x = -0.4; j.elR.rotation.x = -0.4;
      j.head.rotation.y = aware ? 0 : Math.sin(e.t * 0.7) * 0.4;
      if (e.state === 'hit') {
        j.hips.rotation.x = -0.35 + e.t * 0.7;
        j.shL.rotation.x = -2.2; j.shR.rotation.x = -2.2;
      } else j.hips.rotation.x = speed > 0.2 ? 0.12 : 0;
    };

    ctrl.dispose = function () {
      sites.slice().forEach(closeSite);
      strand.hide();
    };

    return ctrl;
  }

  NS.Crime = { create, CFG, TYPES };
})();
