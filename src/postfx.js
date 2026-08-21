/* =========================================================================
   postfx.js — PS급 화면 포스트 프로세싱 파이프라인
   RenderPass → UnrealBloom → 커스텀 그레이딩 → FXAA → GammaCorrection

   커스텀 그레이딩 패스가 이 모듈의 핵심이다.
   · 필름 대비 / 채도 (lift-gamma-gain)
   · 청록-오렌지 톤 스플릿(그림자는 푸르게, 하이라이트는 따뜻하게)
   · 부드러운 비네팅 + 피격 붉은 비네트
   · 색수차(가장자리로 갈수록 R/B 분리) — 속도에 비례
   · 방사형 모션블러 10탭 — 속도감의 핵심
   · 필름 그레인 / 화면 색조 / 화이트 플래시 / 화면 흔들림

   ※ three.js r128 UMD 전역(THREE.*) 전용. ES 모듈 아님.
   ※ 필수 전역이 하나라도 없으면 fx.enabled=false 로 떨어지고
     fx.render() 는 renderer.render(scene,camera) 폴백으로 동작한다.
   ========================================================================= */
(function () {
  const NS = (window.SPIDER = window.SPIDER || {});

  /* ---------------------------------------------------------------- 유틸 */
  function clamp01(v) {
    v = +v;
    if (!(v > 0)) return 0;      // NaN/음수 방어
    return v > 1 ? 1 : v;
  }

  function damp(cur, target, rate, dt) {
    let k = rate * dt;
    if (k > 1) k = 1;
    return cur + (target - cur) * k;
  }

  /* ------------------------------------------------- 커스텀 그레이딩 셰이더 */
  // WebGL1 / GLSL ES 1.0 — texture2D 만 사용, 루프 카운트는 상수.
  const GradeShader = {
    uniforms: {
      tDiffuse: { value: null },
      uTime: { value: 0 },
      uSpeed: { value: 0 },          // 0~1 방사형 블러 + 색수차 세기
      uPulse: { value: 0 },          // 0~1 화이트 플래시
      uTint: { value: null },        // THREE.Color (create 에서 주입)
      uTintAmount: { value: 0 },
      uVignette: { value: 0.62 },
      uAberration: { value: 1 },
      uGrain: { value: 0.03 },
      uShake: { value: 0 },
      uDamage: { value: 0 },
      uResolution: { value: null }   // THREE.Vector2 (create 에서 주입)
    },

    vertexShader: [
      'varying vec2 vUv;',
      'void main() {',
      '  vUv = uv;',
      '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
      '}'
    ].join('\n'),

    fragmentShader: [
      'uniform sampler2D tDiffuse;',
      'uniform float uTime;',
      'uniform float uSpeed;',
      'uniform float uPulse;',
      'uniform vec3  uTint;',
      'uniform float uTintAmount;',
      'uniform float uVignette;',
      'uniform float uAberration;',
      'uniform float uGrain;',
      'uniform float uShake;',
      'uniform float uDamage;',
      'uniform vec2  uResolution;',
      'varying vec2 vUv;',

      'const int TAPS = 10;',                     // 모션블러 탭 수(상수)
      'const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);',
      'const vec3 LIFT  = vec3(0.006, 0.010, 0.022);',   // 그림자를 살짝 들어올리며 푸르게
      'const vec3 GAIN  = vec3(1.050, 1.014, 0.962);',   // 하이라이트는 따뜻하게
      'const vec3 GAMMA = vec3(0.985, 1.000, 1.022);',
      'const vec3 COOL  = vec3(0.40, 0.66, 1.00);',      // 그림자 청록
      'const vec3 WARM  = vec3(1.00, 0.82, 0.58);',      // 하이라이트 오렌지

      'float lum(vec3 c) { return dot(c, LUMA); }',

      // 해시 기반 화이트노이즈(시간 기반 그레인용)
      'float hash12(vec2 p) {',
      '  vec3 p3 = fract(vec3(p.xyx) * 0.1031);',
      '  p3 += dot(p3, p3.yzx + 33.33);',
      '  return fract((p3.x + p3.y) * p3.z);',
      '}',

      'void main() {',
      '  vec2 uv = vUv;',

      // ── 화면 흔들림: UV 자체를 미세하게 민다
      '  if (uShake > 0.0005) {',
      '    float t = uTime * 47.0;',
      '    vec2 sh = vec2(sin(t * 1.7) + 0.5 * sin(t * 3.9),',
      '                   cos(t * 2.3) + 0.5 * cos(t * 5.1));',
      '    uv += sh * uShake * 0.0055;',
      '  }',

      '  vec2 cen = uv - 0.5;',
      '  float rad = length(cen);',
      '  float sp = clamp(uSpeed, 0.0, 1.0);',
      '  vec3 base = texture2D(tDiffuse, uv).rgb;',
      '  vec3 col = base;',

      // ── 방사형 모션블러: 중심에서 바깥으로 샘플을 끌어당긴다
      // base 가 f=0 탭이므로 루프는 1 부터. 총 TAPS 개.
      '  float blur = sp * sp * 0.090 * smoothstep(0.02, 0.55, rad);',
      '  if (blur > 0.0004) {',
      '    vec3 acc = base;',
      '    float wsum = 1.0;',
      '    for (int i = 1; i < TAPS; i++) {',
      '      float f = float(i) / float(TAPS - 1);',
      '      float w = 1.0 - f * 0.72;',
      '      vec2 suv = clamp(uv - cen * blur * f, vec2(0.0015), vec2(0.9985));',
      '      acc += texture2D(tDiffuse, suv).rgb * w;',
      '      wsum += w;',
      '    }',
      '    col = acc / max(wsum, 0.0001);',
      '  }',

      // ── 색수차: 가장자리로 갈수록 R/B 채널을 반대로 민다
      // 블러 결과를 덮어쓰지 않도록 "차분"만 더한다(안 그러면 고속에서 R/B 블러가 사라짐)
      '  float ab = uAberration * (0.0012 + sp * 0.0062) * smoothstep(0.05, 0.78, rad);',
      '  if (ab > 0.00002) {',
      '    vec2 d = cen * ab;',
      '    float cr = texture2D(tDiffuse, clamp(uv - d, vec2(0.0015), vec2(0.9985))).r;',
      '    float cb = texture2D(tDiffuse, clamp(uv + d, vec2(0.0015), vec2(0.9985))).b;',
      '    col.r += (cr - base.r) * 0.85;',
      '    col.b += (cb - base.b) * 0.85;',
      '  }',

      // ── lift-gamma-gain 필름 그레이딩
      '  col = max(col, 0.0);',
      '  col = LIFT + (GAIN - LIFT) * col;',
      '  col = pow(max(col, 0.0), 1.0 / GAMMA);',

      // ── 청록-오렌지 톤 스플릿
      '  float l = clamp(lum(col), 0.0, 1.0);',
      '  float sw = (1.0 - l) * (1.0 - l);',
      '  float hw = pow(l, 1.6);',
      '  col = mix(col, col * COOL, sw * 0.155);',
      '  col = mix(col, col * WARM, hw * 0.130);',

      // ── 대비 + 채도
      '  col = (col - 0.5) * 1.075 + 0.5;',
      '  float g = lum(col);',
      '  col = mix(vec3(g), col, 1.14);',

      // ── 속도 가장자리 압착(빠를수록 화면 테두리가 어두워짐)
      '  col *= 1.0 - sp * 0.26 * smoothstep(0.26, 0.74, rad);',

      // ── 부드러운 비네팅
      // edge0 < edge1 로만 쓴다(역방향 smoothstep 은 GLSL 스펙상 미정의)
      '  float vig = 1.0 - smoothstep(0.16, 0.86, rad);',
      '  col *= mix(1.0, vig, clamp(uVignette, 0.0, 1.0));',

      // ── 피격 붉은 비네트
      '  if (uDamage > 0.001) {',
      '    float dmg = smoothstep(0.14, 0.64, rad) * clamp(uDamage, 0.0, 1.0);',
      '    col = mix(col, vec3(0.62, 0.035, 0.045), dmg * 0.78);',
      '    col *= 1.0 - dmg * 0.10;',
      '  }',

      // ── 화면 색조(능력/상태 표현)
      '  if (uTintAmount > 0.001) {',
      '    vec3 tinted = col * uTint;',
      '    tinted = mix(tinted, uTint * (0.22 + 0.78 * lum(col)), 0.35);',
      '    col = mix(col, tinted, clamp(uTintAmount, 0.0, 1.0));',
      '  }',

      // ── 필름 그레인(시간 기반, 어두운 곳에서 약간 더 보이게)
      '  if (uGrain > 0.0005) {',
      '    vec2 gp = vUv * max(uResolution, vec2(1.0)) + vec2(fract(uTime * 13.0) * 311.7,',
      '                                                        fract(uTime * 17.0) * 197.3);',
      '    float n = hash12(gp) - 0.5;',
      '    col += n * uGrain * (1.25 - 0.85 * lum(col));',
      '  }',

      // ── 화이트 플래시
      '  col = mix(col, vec3(1.0), clamp(uPulse, 0.0, 1.0));',

      '  gl_FragColor = vec4(max(col, 0.0), 1.0);',
      '}'
    ].join('\n')
  };

  /* ------------------------------------------------------------- 폴백 객체 */
  function makeFallback(renderer, scene, camera, why) {
    if (why) console.warn('[PostFX] 비활성 — ' + why);
    return {
      enabled: false,
      composer: null,
      bloomPass: null,
      gradePass: null,
      fxaaPass: null,
      renderPass: null,
      quality: 0,
      render: function () { renderer.render(scene, camera); },
      setSize: function (w, h) {
        if (renderer) renderer.setSize(w, h);
      },
      setQuality: function () {},
      setSpeed: function () {},
      setPulse: function () {},
      setTint: function () {},
      setShake: function () {},
      setDamage: function () {},
      setCamera: function (c) { camera = c; },
      dispose: function () {}
    };
  }

  /* ----------------------------------------------------------------- 생성 */
  function create(renderer, scene, camera, opts) {
    opts = opts || {};
    const mobile = !!opts.mobile;

    if (!renderer || !scene || !camera) return makeFallback(renderer, scene, camera, '인자 누락');

    // 필수 전역 검사 — 하나라도 없으면 즉시 폴백
    const need = ['EffectComposer', 'RenderPass', 'ShaderPass', 'UnrealBloomPass',
      'FXAAShader', 'GammaCorrectionShader', 'CopyShader'];
    for (let i = 0; i < need.length; i++) {
      if (!THREE[need[i]]) return makeFallback(renderer, scene, camera, 'THREE.' + need[i] + ' 없음');
    }

    let composer = null, renderPass = null, bloomPass = null,
      gradePass = null, fxaaPass = null, gammaPass = null;

    try {
      const w = Math.max(1, renderer.domElement.width / Math.max(renderer.getPixelRatio(), 0.0001));
      const h = Math.max(1, renderer.domElement.height / Math.max(renderer.getPixelRatio(), 0.0001));

      composer = new THREE.EffectComposer(renderer);
      // 감마 이중 적용(화면이 뿌옇게 뜨는 현상) 방지 — 중간 버퍼는 반드시 선형
      composer.renderTarget1.texture.encoding = THREE.LinearEncoding;
      composer.renderTarget2.texture.encoding = THREE.LinearEncoding;

      renderPass = new THREE.RenderPass(scene, camera);
      composer.addPass(renderPass);

      bloomPass = new THREE.UnrealBloomPass(
        new THREE.Vector2(w * (mobile ? 0.5 : 1), h * (mobile ? 0.5 : 1)),
        mobile ? 0.35 : 0.50, 0.62, 0.80);
      composer.addPass(bloomPass);

      // 커스텀 그레이딩 (핵심)
      gradePass = new THREE.ShaderPass(GradeShader);
      gradePass.uniforms.uTint.value = new THREE.Color(0xffffff);
      gradePass.uniforms.uResolution.value = new THREE.Vector2(w, h);
      composer.addPass(gradePass);

      fxaaPass = new THREE.ShaderPass(THREE.FXAAShader);
      composer.addPass(fxaaPass);

      // 감마 보정은 반드시 마지막
      gammaPass = new THREE.ShaderPass(THREE.GammaCorrectionShader);
      composer.addPass(gammaPass);
    } catch (e) {
      return makeFallback(renderer, scene, camera, '패스 생성 실패: ' + (e && e.message));
    }

    /* ------------------------------------------------------------ 내부 상태 */
    let time = 0;
    let quality = mobile ? 1 : 2;
    let sizeW = 1, sizeH = 1;

    let speedTarget = 0, speedCur = 0;   // 부드럽게 따라감
    let damageTarget = 0, damageCur = 0; // 부드럽게 따라감
    let pulse = 0;                       // 임펄스(자동 감쇠)
    let shake = 0;                       // 임펄스(자동 감쇠)
    let tintAmount = 0;

    // 품질별 계수
    let kBloom = 1, kAberration = 1, kGrain = 0.03, kVignette = 0.62, kSpeedFx = 1;

    const u = gradePass.uniforms;

    /* -------------------------------------------------------------- 크기 */
    function setSize(w, h) {
      w = Math.max(1, w | 0);
      h = Math.max(1, h | 0);
      sizeW = w; sizeH = h;

      composer.setSize(w, h);
      // setSize 이후에도 선형 인코딩 유지(감마 이중 적용 방지)
      composer.renderTarget1.texture.encoding = THREE.LinearEncoding;
      composer.renderTarget2.texture.encoding = THREE.LinearEncoding;

      const pr = Math.max(renderer.getPixelRatio(), 0.0001);

      if (fxaaPass && fxaaPass.material && fxaaPass.material.uniforms.resolution) {
        fxaaPass.material.uniforms.resolution.value.set(1 / (w * pr), 1 / (h * pr));
      }
      if (bloomPass) {
        // 모바일은 블룸만 절반 해상도로 계산해 부하를 줄인다
        const bs = mobile || quality === 0 ? 0.5 : 1;
        bloomPass.resolution.set(w * bs, h * bs);
        bloomPass.setSize(Math.max(1, w * bs * pr), Math.max(1, h * bs * pr));
      }
      u.uResolution.value.set(w * pr, h * pr);
    }

    /* -------------------------------------------------------------- 품질 */
    function setQuality(level) {
      level = level | 0;
      if (level < 0) level = 0;
      if (level > 2) level = 2;
      quality = level;

      if (level === 0) {              // 성능: 블룸/FXAA/그레인/색수차/모션블러 끔
        bloomPass.enabled = false;
        fxaaPass.enabled = false;
        kBloom = 0; kAberration = 0; kGrain = 0; kVignette = 0.5; kSpeedFx = 0;
      } else if (level === 1) {       // 보통
        bloomPass.enabled = true;
        fxaaPass.enabled = true;
        kBloom = mobile ? 0.35 : 0.42;
        kAberration = 0.6; kGrain = 0.02; kVignette = 0.58; kSpeedFx = 0.7;
      } else {                        // 최고
        bloomPass.enabled = true;
        fxaaPass.enabled = true;
        kBloom = mobile ? 0.35 : 0.50;
        kAberration = 1.0; kGrain = 0.03; kVignette = 0.62; kSpeedFx = 1.0;
      }
      if (bloomPass.enabled) bloomPass.strength = kBloom;
      u.uAberration.value = kAberration;
      u.uGrain.value = kGrain;
      u.uVignette.value = kVignette;
      setSize(sizeW, sizeH);          // 블룸 해상도 재적용
    }

    /* ------------------------------------------------------------ 세터들 */
    // 속도감(0~1). 매 프레임 호출해도 됨 — 내부에서 부드럽게 보간한다.
    function setSpeed(v) { speedTarget = clamp01(v); }

    // 화이트 플래시. 임펄스 — 한 번 1 을 주면 약 0.3초에 걸쳐 스스로 사라진다.
    // 0 을 주면 즉시 해제.
    function setPulse(v) {
      v = clamp01(v);
      pulse = v <= 0 ? 0 : Math.max(pulse, v);
    }

    // 화면 흔들림. 임펄스 — setPulse 와 같은 규칙(약 0.4초 감쇠).
    function setShake(v) {
      v = clamp01(v);
      shake = v <= 0 ? 0 : Math.max(shake, v);
    }

    // 피격 붉은 비네트(0~1). 매 프레임 hp 로 갱신해도 됨 — 보간된다.
    function setDamage(v) { damageTarget = clamp01(v); }

    // 화면 색조. hex 가 null 이면 색조 해제.
    function setTint(hexOrNull, amount) {
      if (hexOrNull === null || hexOrNull === undefined) {
        tintAmount = 0;
        return;
      }
      if (typeof hexOrNull === 'number') u.uTint.value.setHex(hexOrNull);
      else if (hexOrNull.isColor) u.uTint.value.copy(hexOrNull);
      else u.uTint.value.set(hexOrNull);
      tintAmount = clamp01(amount === undefined ? 1 : amount);
    }

    function setCamera(cam) {
      if (!cam) return;
      camera = cam;
      renderPass.camera = cam;
    }

    /* -------------------------------------------------------------- 렌더 */
    function render(dt) {
      // 통합 측에서 fx.enabled = false 로 끄면 즉시 원본 렌더로 폴백
      if (!fx.enabled) { renderer.render(scene, camera); return; }
      dt = +dt;
      if (!(dt > 0) || dt > 0.25) dt = 0.016;   // NaN/스파이크 방어
      time += dt;
      if (time > 100000) time = 0;

      // 임펄스 감쇠
      if (pulse > 0) { pulse -= dt * 3.4; if (pulse < 0) pulse = 0; }
      if (shake > 0) { shake -= dt * 2.6; if (shake < 0) shake = 0; }

      // 부드러운 추종
      speedCur = damp(speedCur, speedTarget, 6.5, dt);
      damageCur = damp(damageCur, damageTarget, 7.0, dt);

      u.uTime.value = time;
      u.uSpeed.value = speedCur * kSpeedFx;
      u.uPulse.value = pulse;
      u.uShake.value = shake;
      u.uDamage.value = damageCur;
      u.uTintAmount.value = tintAmount;

      composer.render(dt);
    }

    function dispose() {
      try {
        if (bloomPass && bloomPass.dispose) bloomPass.dispose();
        if (gradePass && gradePass.material) gradePass.material.dispose();
        if (fxaaPass && fxaaPass.material) fxaaPass.material.dispose();
        if (gammaPass && gammaPass.material) gammaPass.material.dispose();
        if (composer) {
          composer.renderTarget1.dispose();
          composer.renderTarget2.dispose();
        }
      } catch (e) { /* 무시 */ }
    }

    const fx = {
      enabled: true,
      composer: composer,
      renderPass: renderPass,
      bloomPass: bloomPass,
      gradePass: gradePass,
      fxaaPass: fxaaPass,
      gammaPass: gammaPass,
      get quality() { return quality; },
      render: render,
      setSize: setSize,
      setQuality: setQuality,
      setSpeed: setSpeed,
      setPulse: setPulse,
      setTint: setTint,
      setShake: setShake,
      setDamage: setDamage,
      setCamera: setCamera,
      dispose: dispose
    };

    setQuality(quality);
    setSize(window.innerWidth, window.innerHeight);
    return fx;
  }

  NS.PostFX = { create: create };
})();
