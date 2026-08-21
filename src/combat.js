/* =========================================================================
   combat.js — PS 스파이더맨식 근접 전투
   crime.js 를 고치지 않고, crime 이 노출한 배열/필드만 읽고 써서 구현한다.

   · 펀치 콤보(3타 강타) / 공중 저글링 / 웹 야크 / 스파이더 센스 회피
   · 히트스톱 · 카메라 셰이크 · 스파크 + 흰 임팩트 링

   [game.js 통합 규칙]
   1) c.update(dt, time) 는 반드시 crime.update() **뒤에** 부른다.
      (crime 이 매 프레임 적 위치/상태를 덮어쓰므로 그 위에 다시 얹어야 한다.
       회피 무적도 crime 이 damage() 를 부른 직후에 체력을 복구해야 한다.)
   2) c.hitStop 은 "시간 배수"다. 평소 1, 타격 순간 0.06 근처로 떨어진다.
      => game.js 는 `dt *= combat.hitStop` 으로 쓰면 된다. (0 나눗셈 없음)
      내부 히트스톱 타이머는 게임 dt 가 아니라 실시간을 쓰므로 절대 멈춰 굳지 않는다.
   3) c.shake 는 0~1. updateCamera 뒤에 카메라 위치에 노이즈로 더해 쓴다.
   ========================================================================= */
(function () {
  const NS = (window.SPIDER = window.SPIDER || {});
  const V3 = THREE.Vector3;

  const CFG = {
    RANGE: 3.0,          // 펀치 사거리(수평)
    RANGE_Y: 3.2,        // 펀치 허용 높이차
    CONE: 0.15,          // 정면 판정(코사인)
    PUNCH_COOL: 0.24,
    COMBO_WINDOW: 1.2,   // 이 시간 안에 다음 타를 넣으면 콤보 유지
    STUN: 1.2,           // 피격 스턴 시간
    STUN_HEAVY: 1.8,
    KB: 9,               // 일반 타 넉백 속도
    KB_HEAVY: 22,        // 3타 강타 넉백 속도
    LIFT: 7.2,           // 저글링 띄우는 속도
    LIFT_AIR: 4.4,       // 공중 추가타로 다시 띄우는 속도
    JG_GRAV: 0.35,       // 저글링 중 중력 배수 (천천히 떨어진다)
    GRAV: 22,
    FREEZE: 0.06,        // 히트스톱 기본 시간
    FREEZE_HEAVY: 0.12,
    FREEZE_SCALE: 0.06,  // 히트스톱 동안의 시간 배수
    YANK_RANGE: 30,
    YANK_TIME: 0.35,
    YANK_HOLD: 2.5,      // 끌려온 적이 멈추는 거리
    DODGE_TIME: 0.45,    // 무적 시간
    DODGE_COOL: 0.5,
    DODGE_DIST: 4.6,
    SENSE_RANGE: 26
  };

  /* ------------------------------------------------------- 절차 텍스처 */
  function puffTexture() {
    const S = 64, c = document.createElement('canvas');
    c.width = c.height = S;
    const x = c.getContext('2d');
    const g = x.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    g.addColorStop(0, 'rgba(255,255,255,0.85)');
    g.addColorStop(0.45, 'rgba(190,215,255,0.35)');
    g.addColorStop(1, 'rgba(160,190,255,0)');
    x.fillStyle = g;
    x.fillRect(0, 0, S, S);
    return new THREE.CanvasTexture(c);
  }

  function markTexture() {
    const S = 64, c = document.createElement('canvas');
    c.width = c.height = S;
    const x = c.getContext('2d');
    x.clearRect(0, 0, S, S);
    x.strokeStyle = 'rgba(255,255,255,0.95)';
    x.lineWidth = 5;
    x.lineJoin = 'round';
    // 위험 표식: 위로 뾰족한 삼각형
    x.beginPath();
    x.moveTo(S / 2, 8); x.lineTo(S - 10, S - 12); x.lineTo(10, S - 12);
    x.closePath();
    x.stroke();
    x.fillStyle = 'rgba(255,255,255,0.28)';
    x.fill();
    return new THREE.CanvasTexture(c);
  }

  /* 모듈 스코프 재사용 벡터 (매 프레임 new 금지) */
  const _v = new V3(), _fwd = new V3(),
    _from = new V3(), _to = new V3(), _look = new V3(), _tmp = new V3();
  const _hit = { x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, dist: 0, box: null };
  const _idx = [];

  function nowSec() {
    return ((typeof performance !== 'undefined' && performance.now)
      ? performance.now() : Date.now()) * 0.001;
  }

  /* NaN/Infinity 방어. 한 번이라도 NaN 이 좌표에 들어가면 행렬 → 그림자 카메라 →
     바운딩까지 전부 오염되어 도시가 통째로 사라진다. 쓰기 직전에 반드시 거른다. */
  function fin(v, d) {
    return (typeof v === 'number' && v > -Infinity && v < Infinity) ? v : (d || 0);
  }
  function ok(v) { return typeof v === 'number' && v > -Infinity && v < Infinity; }

  /* ============================================================ 생성 */
  function create(scene, player, crime) {
    const city = player.city;
    const HALF = city ? city.HALF : 1e5;

    /* ---------------- 이펙트 풀 ---------------- */
    const ringGeo = new THREE.RingGeometry(0.22, 0.62, 18, 1);
    const rings = [];
    for (let i = 0; i < 6; i++) {
      const m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0, depthWrite: false,
        side: THREE.DoubleSide, blending: THREE.AdditiveBlending, toneMapped: false
      }));
      m.visible = false; m.renderOrder = 4;
      scene.add(m);
      rings.push({ mesh: m, t: 0 });
    }
    let ringCur = 0;

    const puffTex = puffTexture();
    const puffs = [];
    for (let i = 0; i < 6; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({
        map: puffTex, transparent: true, opacity: 0, depthWrite: false,
        blending: THREE.AdditiveBlending, toneMapped: false
      }));
      s.visible = false; s.scale.set(1.6, 2.2, 1);
      scene.add(s);
      puffs.push({ sp: s, t: 0 });
    }
    let puffCur = 0;

    const markTex = markTexture();
    const marks = [];
    for (let i = 0; i < 4; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({
        map: markTex, transparent: true, opacity: 0, depthWrite: false,
        depthTest: false, toneMapped: false
      }));
      s.visible = false; s.scale.set(0.75, 0.75, 1); s.renderOrder = 6;
      scene.add(s);
      marks.push(s);
    }

    const yankStrand = NS.Web.createStrand(scene, { radius: 0.045 });

    /* ---------------- 상태 ---------------- */
    const c = {
      comboCount: 0,
      comboTimer: 0,
      hitStop: 1,          // 시간 배수 (평소 1)
      shake: 0,
      canDodge: false,
      invuln: 0,
      dodgeCool: 0,
      punchCool: 0,
      damageMul: 1,
      lastHit: '',
      juggling: 0
    };

    let disposed = false;         // dispose 뒤 호출돼도 죽지 않게
    let freezeT = 0;              // 히트스톱 남은 실시간
    let lastReal = nowSec();
    let clockT = 0;
    let punchAnimT = 0, punchSide = 'R';
    let punchTarget = null;
    let yankT = 0, yankTarget = null;
    let hpGuard = crime.hp, comboGuard = crime.combo;
    let dangerEnemy = null;
    const active = [];            // 스턴/저글링/넉백 중인 적

    /* ---------------- 유틸 ---------------- */
    function valid(e) {
      return !!e && !e.dead && !e.arrested && crime.enemies.indexOf(e) >= 0;
    }

    /* e.T 는 crime.js 의 TYPES 를 그대로 공유한다(같은 타입 전원이 한 객체).
       그래서 speed 를 건드리기 전에 반드시 이 적 전용으로 복제한다.
       crime 은 언제나 e.T 를 통해 읽으므로 복제해도 동작이 같다. */
    function ownType(e) {
      if (!e.__ownT) {
        e.T = Object.assign({}, e.T);
        e.__ownT = true;
        e.__baseSpeed = e.T.speed;
      }
      if (e.__baseSpeed == null) e.__baseSpeed = e.T.speed;
      return e.T;
    }

    function restoreType(e) {
      if (e && e.__ownT && e.__baseSpeed != null) e.T.speed = e.__baseSpeed;
    }

    /* 이 모듈이 적에게 남긴 임시 변경을 전부 되돌린다.
       체포 / 현장 종료(splice) / dispose / 능력 중첩 — 어떤 경로로 빠져나가도
       반드시 여기를 통과하게 해서 speed 0 이나 비틀린 허리가 남지 않게 한다. */
    function clearFx(e) {
      if (!e) return;
      restoreType(e);
      e.__stun = 0;
      e.__jg = false;
      e.__jv = 0;
      e.__kx = 0;
      e.__kz = 0;
      if (e.pos) e.pos.y = 0;
      // crime 은 hips.rotation.x 만 쓴다. z 는 우리가 넣은 값이라 우리가 지워야 한다.
      const j = e.model && e.model.j;
      if (j && j.hips) j.hips.rotation.z = 0;
    }

    function track(e) {
      if (active.indexOf(e) < 0) active.push(e);
    }

    /* 건물 안인지 (crime.inside 와 같은 판정, 여긴 접근 불가라 다시 구현) */
    function blocked(x, z) {
      if (!city) return false;
      NS.City.nearBoxes(city, x, z, 2, _idx);
      for (let i = 0; i < _idx.length; i++) {
        const b = city.boxes[_idx[i]];
        if (x > b.x0 - 1.0 && x < b.x1 + 1.0 && z > b.z0 - 1.0 && z < b.z1 + 1.0) return true;
      }
      return false;
    }

    /* 웹 진행도를 올린다. 단 (필요 발수 - 1) 을 절대 넘지 않는다.
       — crime 의 arrest() 를 직접 부를 수 없으므로, 마무리는 항상
         crime.tryWebShot() 의 마지막 한 발이 하게 만든다. */
    function addWebProgress(e, n) {
      if (!e || !e.T || !e.webBlobs) return;
      const cap = Math.max(0, (e.T.hp || 1) - 1);
      const w = Math.min(cap, e.webs + n);
      if (w <= e.webs) return;
      e.webs = w;
      for (let i = 0; i < e.webs && i < e.webBlobs.length; i++) {
        e.webBlobs[i].visible = true;
      }
    }

    function impact(x, y, z, big) {
      if (!ok(x) || !ok(y) || !ok(z)) return;   // NaN 좌표를 씬에 넣지 않는다
      const it = rings[ringCur % rings.length]; ringCur++;
      it.mesh.visible = true;
      it.mesh.position.set(x, y, z);
      _look.set(player.pos.x, player.pos.y + 1.4, player.pos.z);
      it.mesh.lookAt(_look);
      it.mesh.scale.setScalar(big ? 0.8 : 0.5);
      it.mesh.material.opacity = 0.95;
      it.t = big ? 0.34 : 0.22;
      if (player.sparks) {
        _tmp.set(x, y, z);
        player.sparks.burst(_tmp, big ? 16 : 9, big ? 1.1 : 0.7, big ? 9 : 6);
      }
      if (NS.sfx && NS.sfx.land) NS.sfx.land(big ? 0.55 : 0.22);
    }

    function ghost(x, y, z, s) {
      if (!ok(x) || !ok(y) || !ok(z)) return;
      const it = puffs[puffCur % puffs.length]; puffCur++;
      it.sp.visible = true;
      it.sp.position.set(x, y, z);
      it.sp.scale.set(1.5 * (s || 1), 2.1 * (s || 1), 1);
      it.sp.material.opacity = 0.7;
      it.t = 0.3;
    }

    function freeze(sec) {
      if (sec > freezeT) freezeT = sec;
    }

    function addShake(v) {
      c.shake = Math.min(1, c.shake + v);
    }

    /* ---------------- 조준 ---------------- */
    function findTarget(range, cone) {
      const list = crime.enemies;
      let best = null, bs = 1e9;
      _fwd.set(Math.sin(player.camYaw), 0, Math.cos(player.camYaw));
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        if (e.dead || e.arrested) continue;
        const dx = e.pos.x - player.pos.x;
        const dz = e.pos.z - player.pos.z;
        const dy = (e.pos.y + 1.0) - (player.pos.y + 1.0);
        if (Math.abs(dy) > CFG.RANGE_Y) continue;
        const d = Math.hypot(dx, dz);
        if (d > range) continue;
        let dot = 1;
        if (d > 0.001) dot = (dx / d) * _fwd.x + (dz / d) * _fwd.z;
        if (dot < cone) continue;
        const s = d - dot * 1.6;
        if (s < bs) { bs = s; best = e; }
      }
      return best;
    }

    /* ---------------- 스턴 / 저글링 ---------------- */
    function stun(e, sec) {
      ownType(e);
      e.__stun = Math.max(e.__stun || 0, sec);
      e.atkCool = Math.max(e.atkCool || 0, sec + 0.2);
      track(e);
    }

    function juggle(e, up, bonus) {
      ownType(e);
      e.__jg = true;
      e.__jv = fin(up, 0);
      if (bonus && !e.__airBonus) {
        e.__airBonus = true;
        // 공중에 뜬 적은 웹 한 발이면 포박된다 (진행도를 필요발수-1 까지 채운다)
        addWebProgress(e, e.T.hp);
      }
      track(e);
    }

    function endJuggle(e) {
      if (!e.__jg) return;
      e.__jg = false;
      e.__jv = 0;
      if (e.pos) e.pos.y = 0;
    }

    /* ---------------- 펀치 ---------------- */
    c.punch = function () {
      if (disposed || c.punchCool > 0) return false;
      c.punchCool = CFG.PUNCH_COOL;
      punchAnimT = 0.2;

      const e = findTarget(CFG.RANGE, CFG.CONE);
      if (!e) {
        punchTarget = null;
        if (NS.sfx && NS.sfx.miss) NS.sfx.miss();
        return false;
      }
      punchTarget = e;
      punchSide = (c.comboCount % 2 === 0) ? 'R' : 'L';

      if (c.comboTimer <= 0) c.comboCount = 0;
      c.comboCount++;
      c.comboTimer = CFG.COMBO_WINDOW;

      const mul = c.damageMul;
      const heavy = (c.comboCount % 3 === 0);
      const aerial = !player.grounded && player.state !== 'ground';

      // 방향 (플레이어 → 적) — 0 길이면 정면으로 밀어낸다
      let dx = e.pos.x - player.pos.x, dz = e.pos.z - player.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > 1e-4 && ok(d)) { dx /= d; dz /= d; }
      else { dx = _fwd.x; dz = _fwd.z; }        // _fwd 는 findTarget 에서 이미 채워졌다
      if (!ok(dx) || !ok(dz)) { dx = 0; dz = 1; }

      ownType(e);
      const kb = (heavy ? CFG.KB_HEAVY : CFG.KB) * mul;
      e.__kx = fin(fin(e.__kx) + dx * kb);
      e.__kz = fin(fin(e.__kz) + dz * kb);

      if (aerial) {
        // 공중 저글링: 처음이면 크게, 이어치면 조금 더 띄운다
        juggle(e, e.__jg ? CFG.LIFT_AIR : CFG.LIFT, true);
        e.__kx *= 0.45; e.__kz *= 0.45;
      } else if (heavy) {
        // 강타는 살짝 띄우면서 날린다 (지상 강타에는 웹 보너스 없음)
        juggle(e, 3.4 * mul, false);
      }

      stun(e, heavy ? CFG.STUN_HEAVY : CFG.STUN);
      if (heavy) addWebProgress(e, mul >= 2 ? 2 : 1);

      impact(e.pos.x, e.pos.y + 1.1, e.pos.z, heavy);
      freeze(heavy ? CFG.FREEZE_HEAVY : CFG.FREEZE);
      addShake(heavy ? 0.55 : 0.22);
      c.lastHit = heavy ? '강타!' : ('타격 ×' + c.comboCount);
      if (heavy && crime.flash) crime.flash('강타!  콤보 ×' + c.comboCount, '#ffd166');
      return true;
    };

    /* ---------------- 웹 야크 ---------------- */
    c.webYank = function () {
      if (disposed || yankT > 0) return false;
      const e = crime.aimTarget ? crime.aimTarget(CFG.YANK_RANGE) : null;
      if (!valid(e)) return false;
      yankTarget = e;
      yankT = CFG.YANK_TIME;
      ownType(e);
      endJuggle(e);
      stun(e, CFG.STUN + CFG.YANK_TIME);
      e.__kx = 0; e.__kz = 0;
      yankStrand.show();
      if (NS.sfx && NS.sfx.thwip) NS.sfx.thwip(0.85);
      addShake(0.12);
      if (crime.flash) crime.flash('웹 야크!', '#9fd8ff');
      return true;
    };

    /* ---------------- 회피 (스파이더 센스) ---------------- */
    c.dodge = function () {
      if (disposed || c.dodgeCool > 0) return false;
      const perfect = c.canDodge;
      c.dodgeCool = CFG.DODGE_COOL;
      c.invuln = Math.max(c.invuln, CFG.DODGE_TIME);
      hpGuard = crime.hp;
      comboGuard = crime.combo;

      // 방향: 위험한 적이 있으면 그 적의 옆(측면)으로, 없으면 카메라 뒤로
      _fwd.set(Math.sin(player.camYaw), 0, Math.cos(player.camYaw));
      let dx, dz;
      if (valid(dangerEnemy)) {
        const ax = player.pos.x - dangerEnemy.pos.x;
        const az = player.pos.z - dangerEnemy.pos.z;
        const al = Math.hypot(ax, az) || 1;
        // 적→나 방향의 수직(측면) + 뒤로 조금
        dx = (-az / al) * 0.8 + (ax / al) * 0.6;
        dz = (ax / al) * 0.8 + (az / al) * 0.6;
      } else {
        dx = -_fwd.x; dz = -_fwd.z;
      }
      const dl = Math.hypot(dx, dz);
      if (dl > 1e-4 && ok(dl)) { dx /= dl; dz /= dl; }
      else { dx = -fin(_fwd.x); dz = -fin(_fwd.z, 1); }
      if (!ok(dx) || !ok(dz) || (dx === 0 && dz === 0)) { dx = 0; dz = -1; }

      const ox = player.pos.x, oy = player.pos.y, oz = player.pos.z;

      // 벽에 박히지 않게 거리 제한. 시작점이 이미 NaN 이면 이동 자체를 포기한다.
      let dist = CFG.DODGE_DIST;
      if (!ok(ox) || !ok(oy) || !ok(oz)) dist = 0;
      else if (city && NS.City.raycast(city, ox, oy + 1.1, oz,
        dx, 0, dz, dist + 0.8, _hit)) {
        dist = Math.max(0, Math.min(dist, fin(_hit.dist, dist + 0.8) - 0.8));
      }

      // 스윙 중에는 순간이동 금지 — 줄 길이가 고정이라 로프가 튄다. 속도만 준다.
      if (player.state === 'swing' || (player.web && player.web.on)) dist = 0;

      if (dist > 0) {
        const nx = ox + dx * dist, nz = oz + dz * dist;
        if (ok(nx) && ok(nz)) {
          player.pos.x = Math.max(-HALF, Math.min(HALF, nx));
          player.pos.z = Math.max(-HALF, Math.min(HALF, nz));
        }
      }
      player.vel.x = fin(player.vel.x) + dx * (dist > 0 ? 4.5 : 9);
      player.vel.z = fin(player.vel.z) + dz * (dist > 0 ? 4.5 : 9);
      // player.rig 는 슈트 교체 때 통째로 갈린다 — 매번 새로 읽는다
      if (player.rig && player.rig.root) player.rig.root.position.copy(player.pos);

      // 잔상
      for (let i = 0; i < 3; i++) {
        const k = i / 3;
        ghost(ox + (player.pos.x - ox) * k, oy + 1.0, oz + (player.pos.z - oz) * k, 1 - k * 0.3);
      }
      if (NS.sfx && NS.sfx.jump) NS.sfx.jump();

      if (perfect) {
        // 퍼펙트 닷지: 짧은 슬로우 + 연출
        freeze(0.1);
        addShake(0.2);
        c.invuln = Math.max(c.invuln, CFG.DODGE_TIME + 0.15);
        if (crime.flash) crime.flash('회피!', '#8ff5ff');
        // 근처 위험 적의 공격을 한 박자 늦춘다
        if (valid(dangerEnemy)) dangerEnemy.atkCool = Math.max(dangerEnemy.atkCool || 0, 0.9);
      }
      return true;
    };

    c.setDamageMul = function (m) {
      c.damageMul = (typeof m === 'number' && m > 0) ? m : 1;
    };

    /* ---------------- 무적 중 피해 무효화 ---------------- */
    function suppressAttacks() {
      const list = crime.enemies;
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        if (e.dead || e.arrested) continue;
        const dx = e.pos.x - player.pos.x, dz = e.pos.z - player.pos.z;
        if (dx * dx + dz * dz > 900) continue;      // 30m 밖은 무시
        if ((e.atkCool || 0) < 0.3) e.atkCool = 0.3;
      }
    }

    /* ---------------- 스파이더 센스 ---------------- */
    function senseScan() {
      const list = crime.enemies;
      let found = null, best = 1e9, shown = 0;
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        if (e.dead || e.arrested || e.__stun > 0) continue;
        const dx = e.pos.x - player.pos.x, dz = e.pos.z - player.pos.z;
        const dy = player.pos.y - e.pos.y;
        const d = Math.hypot(dx, dz);
        const cool = e.atkCool || 0;
        let danger = false;
        if (e.T.ranged) {
          danger = d < CFG.SENSE_RANGE && cool < 0.45 && Math.abs(dy) < 14;
        } else if (!e.T.flee) {
          danger = d < 4.4 && cool < 0.45 && Math.abs(dy) < 2.6;
        }
        if (!danger) continue;
        if (shown < marks.length && ok(e.pos.x) && ok(e.pos.y) && ok(e.pos.z)) {
          const s = marks[shown++];
          s.visible = true;
          s.position.set(e.pos.x, e.pos.y + 2.15, e.pos.z);
          s.material.opacity = 0.55 + 0.45 * Math.sin(clockT * 22);
        }
        if (d < best) { best = d; found = e; }
      }
      for (let i = shown; i < marks.length; i++) marks[i].visible = false;
      dangerEnemy = found;
      c.canDodge = !!found;
    }

    /* ---------------- 적 상태 유지 ---------------- */
    function updateEnemies(dt) {
      for (let i = active.length - 1; i >= 0; i--) {
        const e = active[i];
        if (!valid(e)) {
          // 체포 / 현장 종료(crime.enemies 에서 splice) — 원복을 끝까지 하고 뺀다
          clearFx(e);
          active.splice(i, 1);
          continue;
        }

        // 좌표가 한 번이라도 오염되면 모델 행렬 → 그림자 → 씬 전체로 번진다.
        // 여기서 잡아서 마지막 정상 위치로 되돌린다.
        if (!ok(e.pos.x) || !ok(e.pos.y) || !ok(e.pos.z)) {
          const r = e.model && e.model.root;
          const rx = r && ok(r.position.x) ? r.position.x : 0;
          const rz = r && ok(r.position.z) ? r.position.z : 0;
          e.pos.set(rx, 0, rz);
          e.__kx = 0; e.__kz = 0; e.__jg = false; e.__jv = 0;
        }

        // 스턴: crime 이 매 프레임 상태를 덮어쓰므로 speed 를 0 으로 눌러 둔다
        if (e.__stun > 0) {
          e.__stun -= dt;
          ownType(e);                 // e.T 는 TYPES 공유 객체다. 복제 없이 0 을 쓰면 전원이 굳는다
          e.T.speed = 0;
          e.atkCool = Math.max(e.atkCool || 0, 0.25);
          const j = e.model && e.model.j;
          if (j && j.hips) {
            // crime 은 hips.rotation.x 만 쓰므로 z 로 비틀거림을 표현
            j.hips.rotation.z = Math.sin(clockT * 26) * 0.16 * Math.min(1, e.__stun);
          }
          if (e.__stun <= 0) {
            e.__stun = 0;
            restoreType(e);
            if (j && j.hips) j.hips.rotation.z = 0;
          }
        }

        // 저글링: y 를 직접 다룬다 (crime 은 e.pos.y 를 그대로 모델에 반영한다)
        if (e.__jg) {
          ownType(e);                 // speed 를 건드리기 전 반드시 전용 T 확보
          e.T.speed = 0;
          e.__jv = fin(e.__jv) - CFG.GRAV * CFG.JG_GRAV * dt;
          e.pos.y = fin(e.pos.y) + e.__jv * dt;
          if (!(e.pos.y > 0)) {       // NaN 도 이쪽으로 떨어진다
            e.pos.y = 0;
            e.__jg = false;
            e.__jv = 0;
            impact(e.pos.x, 0.3, e.pos.z, false);
            stun(e, 0.8);
            addShake(0.12);
          }
        }

        // 넉백
        if (e.__kx || e.__kz) {
          if (!ok(e.__kx) || !ok(e.__kz)) {
            e.__kx = 0; e.__kz = 0;
          } else {
            const nx = e.pos.x + e.__kx * dt;
            const nz = e.pos.z + e.__kz * dt;
            if (!blocked(nx, nz)) {
              e.pos.x = Math.max(-HALF, Math.min(HALF, nx));
              e.pos.z = Math.max(-HALF, Math.min(HALF, nz));
            } else {
              // 벽에 처박음 — 살짝 추가 스턴
              e.__kx = 0; e.__kz = 0;
              stun(e, 0.5);
              impact(e.pos.x, e.pos.y + 1.0, e.pos.z, false);
            }
            const damp = Math.exp(-7 * dt);
            e.__kx *= damp; e.__kz *= damp;
            if (Math.abs(e.__kx) < 0.06 && Math.abs(e.__kz) < 0.06) { e.__kx = 0; e.__kz = 0; }
          }
        }

        // 위치를 모델에 즉시 반영 (crime.update 뒤에 불리므로 이게 최종값)
        if (e.model && e.model.root && ok(e.pos.x) && ok(e.pos.y) && ok(e.pos.z)) {
          e.model.root.position.set(e.pos.x, e.pos.y, e.pos.z);
        }

        // 남은 효과가 하나도 없을 때만 목록에서 뺀다 (원복 보장)
        const busy = (e.__stun > 0) || e.__jg || !!e.__kx || !!e.__kz;
        if (!busy) {
          restoreType(e);
          // 목록을 빠져나가는 모든 경로에서 우리가 남긴 흔적을 지운다.
          // crime 은 e.pos.y 를 그대로 쓰므로 여기서 안 내리면 적이 공중에 굳는다.
          if (e.pos && e.pos.y !== 0) e.pos.y = 0;
          const jj = e.model && e.model.j;
          if (jj && jj.hips) jj.hips.rotation.z = 0;
          if (e.model && e.model.root) e.model.root.position.set(e.pos.x, 0, e.pos.z);
          active.splice(i, 1);
        }
      }
      c.juggling = 0;
      for (let i = 0; i < active.length; i++) if (active[i].__jg) c.juggling++;
    }

    /* ---------------- 매 프레임 ---------------- */
    c.update = function (dt, time) {
      if (disposed || !crime || !crime.enemies) { c.hitStop = 1; return; }
      // 실시간 (히트스톱으로 dt 가 0 이 되어도 스스로 풀리게)
      const n = nowSec();
      let rt = n - lastReal;
      lastReal = n;
      if (!(rt > 0)) rt = 0;
      if (rt > 0.1) rt = 0.1;
      clockT += rt;
      if (time == null) time = clockT;

      if (!(dt > 0)) dt = 0;
      if (dt > 0.1) dt = 0.1;

      // 히트스톱 (시간 배수)
      if (freezeT > 0) {
        freezeT -= rt;
        c.hitStop = freezeT > 0 ? CFG.FREEZE_SCALE : 1;
      } else c.hitStop = 1;
      c.shake = Math.max(0, c.shake - rt * 3.4);

      // 타이머
      if (c.punchCool > 0) c.punchCool -= dt;
      if (c.dodgeCool > 0) c.dodgeCool -= dt;
      if (c.comboTimer > 0) {
        c.comboTimer -= dt;
        if (c.comboTimer <= 0) { c.comboCount = 0; c.lastHit = ''; }
      }
      if (punchAnimT > 0) punchAnimT -= dt;

      // 무적 — crime 을 못 고치므로 체력을 되돌려 피해를 무효화한다
      if (c.invuln > 0) {
        c.invuln -= dt;
        suppressAttacks();
        if (crime.hp < hpGuard && crime.hp > 0) {
          crime.hp = hpGuard;
          crime.hurtFlash = 0;
          crime.damageTimer = 0;
        }
        if (crime.combo < comboGuard) crime.combo = comboGuard;
        if (c.invuln <= 0) { c.invuln = 0; hpGuard = crime.hp; comboGuard = crime.combo; }
      } else {
        hpGuard = crime.hp;
        comboGuard = crime.combo;
      }

      // 웹 야크 진행
      if (yankT > 0) {
        if (!valid(yankTarget)) {
          yankT = 0; yankTarget = null; yankStrand.hide();
        } else {
          yankT -= dt;
          const e = yankTarget;
          _fwd.set(Math.sin(player.camYaw), 0, Math.cos(player.camYaw));
          const tx = fin(player.pos.x + _fwd.x * CFG.YANK_HOLD, e.pos.x);
          const tz = fin(player.pos.z + _fwd.z * CFG.YANK_HOLD, e.pos.z);
          const ty = fin(player.grounded ? 0 : Math.max(0, player.pos.y - 1.2), 0);
          const k = 1 - Math.exp(-11 * dt);
          e.pos.x = fin(e.pos.x + (tx - e.pos.x) * k, e.pos.x);
          e.pos.z = fin(e.pos.z + (tz - e.pos.z) * k, e.pos.z);
          e.pos.y = fin(e.pos.y + (ty - e.pos.y) * k, 0);
          e.__kx = 0; e.__kz = 0;
          // ownType 없이 __jg 를 켜면 updateEnemies 가 공유 TYPES.speed 를 0 으로 만든다
          if (!player.grounded && e.pos.y > 0.4) { ownType(e); e.__jg = true; e.__jv = 0.5; track(e); }
          if (e.model && e.model.root && ok(e.pos.x) && ok(e.pos.y) && ok(e.pos.z)) {
            e.model.root.position.set(e.pos.x, e.pos.y, e.pos.z);
          }

          // 슈트 교체 시 player.rig 가 통째로 갈리므로 캐시하지 않고 매번 읽는다
          if (player.rig && player.rig.j && player.rig.j.handR) {
            NS.Character.handWorld(player.rig, 'R', _from);
          } else _from.copy(player.pos);
          _to.set(e.pos.x, e.pos.y + 1.0, e.pos.z);
          yankStrand.update(_from, _to, 1, time, 1);

          if (yankT <= 0) {
            yankT = 0;
            yankStrand.hide();
            stun(e, CFG.STUN);
            impact(e.pos.x, e.pos.y + 1.0, e.pos.z, false);
            addShake(0.18);
            yankTarget = null;
          }
        }
      }

      updateEnemies(dt);
      senseScan();

      // 펀치 팔 조준 (player.update 뒤에 불리므로 이번 프레임 포즈를 덮어쓴다)
      // punchTarget 은 splice 로 사라질 수 있다 — 유효하지 않으면 즉시 참조를 끊는다
      if (!valid(punchTarget) || punchAnimT <= 0) {
        punchTarget = null;
      } else if (player.rig && player.rig.root) {
        _v.set(punchTarget.pos.x, punchTarget.pos.y + 1.15, punchTarget.pos.z);
        if (ok(_v.x) && ok(_v.y) && ok(_v.z)) {
          NS.Character.aimArm(player.rig, punchSide, _v, -0.1);
          player.rig.root.updateMatrixWorld(true);
        }
      }

      // 이펙트 갱신
      for (let i = 0; i < rings.length; i++) {
        const it = rings[i];
        if (!it.mesh.visible) continue;
        it.t -= rt;
        if (it.t <= 0) { it.mesh.visible = false; it.mesh.material.opacity = 0; continue; }
        const s = it.mesh.scale.x + rt * 9;
        it.mesh.scale.set(s, s, s);
        it.mesh.material.opacity = Math.min(1, it.t * 4);
      }
      for (let i = 0; i < puffs.length; i++) {
        const it = puffs[i];
        if (!it.sp.visible) continue;
        it.t -= rt;
        if (it.t <= 0) { it.sp.visible = false; it.sp.material.opacity = 0; continue; }
        it.sp.material.opacity = Math.max(0, it.t * 2.2);
      }
    };

    /* ---------------- 정리 ---------------- */
    c.dispose = function () {
      if (disposed) return;
      disposed = true;

      // 적에게 남긴 변경(speed 0, 저글링 y, 비틀린 허리)을 전부 원복
      for (let i = active.length - 1; i >= 0; i--) clearFx(active[i]);
      active.length = 0;

      // 스턴 중이라 active 밖에 있을 수 있는 참조까지 정리
      clearFx(punchTarget); clearFx(yankTarget);
      punchTarget = null; yankTarget = null; dangerEnemy = null;

      // 히트스톱이 걸린 채 dispose 되면 game.js 의 dt *= hitStop 이 영원히 0.06 이 된다
      yankT = 0; freezeT = 0; punchAnimT = 0;
      c.hitStop = 1; c.shake = 0; c.invuln = 0;
      c.canDodge = false; c.juggling = 0; c.comboCount = 0; c.comboTimer = 0;

      yankStrand.hide();
      if (yankStrand.mesh) {                     // createStrand 가 씬에 붙인 메시 — 우리가 뗀다
        scene.remove(yankStrand.mesh);
        if (yankStrand.mesh.geometry) yankStrand.mesh.geometry.dispose();
        if (yankStrand.mesh.material) yankStrand.mesh.material.dispose();
      }
      rings.forEach(it => { scene.remove(it.mesh); it.mesh.material.dispose(); });
      ringGeo.dispose();
      puffs.forEach(it => { scene.remove(it.sp); it.sp.material.dispose(); });
      marks.forEach(s => { scene.remove(s); s.material.dispose(); });
      puffTex.dispose();
      markTex.dispose();
    };

    return c;
  }

  NS.Combat = { create, CFG };
})();
