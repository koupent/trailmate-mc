import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const ENEMY_COLORS = {
  skeleton: 0xfb7185,
  creeper: 0x4ade80,
  spider: 0xa78bfa,
  zombie: 0xef4444
};

const MOVE_COLORS = {
  attack: 0xf97316,
  dodge: 0x38bdf8,
  positioning: 0xa78bfa,
  advance: 0xfacc15,
  recovery: 0xc084fc,
  survival: 0xf87171,
  stay: 0x94a3b8
};

export function createScene(container) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b1220);

  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 200);
  camera.position.set(14, 16, 18);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  container.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.target.set(0, 1, 0);
  // 既定は固定。ノックバックの相対移動が見やすい。追従は明示オン。
  let followBot = false;
  let lastBotLook = null;

  scene.add(new THREE.AmbientLight(0xffffff, 0.65));
  const sun = new THREE.DirectionalLight(0xffffff, 0.9);
  sun.position.set(8, 18, 6);
  scene.add(sun);

  const grid = new THREE.GridHelper(24, 24, 0x334155, 0x1e293b);
  grid.position.y = 0.02;
  scene.add(grid);

  const root = new THREE.Group();
  scene.add(root);
  const fxRoot = new THREE.Group();
  scene.add(fxRoot);

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  /** @type {Array<{ mesh: THREE.Object3D, born: number, life: number, rise?: number }>} */
  let timedFx = [];

  function resize() {
    const width = container.clientWidth || 760;
    const height = container.clientHeight || 520;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
  }

  function disposeObject(object) {
    object.traverse?.((child) => {
      child.geometry?.dispose?.();
      if (child.material) {
        if (Array.isArray(child.material)) child.material.forEach((item) => item.dispose?.());
        else {
          child.material.map?.dispose?.();
          child.material.dispose?.();
        }
      }
    });
  }

  function clearGroup(group) {
    while (group.children.length) {
      const child = group.children.pop();
      disposeObject(child);
    }
  }

  function addBox(parent, x, y, z, w, h, d, color, opacity = 1) {
    const geometry = new THREE.BoxGeometry(w, h, d);
    const material = new THREE.MeshLambertMaterial({
      color,
      transparent: opacity < 1,
      opacity,
      emissive: opacity < 1 ? color : 0x000000,
      emissiveIntensity: opacity < 1 ? 0.35 : 0
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    parent.add(mesh);
    return mesh;
  }

  function makeLabelSprite(lines, options = {}) {
    const width = options.width || 256;
    const height = options.height || 96;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = options.bg || 'rgba(15, 23, 42, 0.72)';
    roundRect(ctx, 8, 8, width - 16, height - 16, 12);
    ctx.fill();
    ctx.fillStyle = options.color || '#f8fafc';
    ctx.font = options.font || 'bold 28px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const startY = height / 2 - ((lines.length - 1) * 16);
    lines.forEach((line, index) => {
      ctx.fillText(line, width / 2, startY + index * 32);
    });
    const texture = new THREE.CanvasTexture(canvas);
    const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
    const sprite = new THREE.Sprite(material);
    const scale = options.scale || 2.2;
    sprite.scale.set(scale, scale * (height / width), 1);
    return sprite;
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function addHpBar(parent, x, y, z, ratio, width = 1.2) {
    const group = new THREE.Group();
    group.position.set(x, y, z);
    const back = new THREE.Mesh(
      new THREE.PlaneGeometry(width, 0.14),
      new THREE.MeshBasicMaterial({ color: 0x111827, transparent: true, opacity: 0.85, depthWrite: false })
    );
    const fillWidth = Math.max(0.05, width * Math.max(0, Math.min(1, ratio)));
    const fill = new THREE.Mesh(
      new THREE.PlaneGeometry(fillWidth, 0.1),
      new THREE.MeshBasicMaterial({
        color: ratio > 0.5 ? 0x4ade80 : ratio > 0.25 ? 0xfbbf24 : 0xf87171,
        depthWrite: false
      })
    );
    fill.position.x = -(width - fillWidth) / 2;
    back.position.z = 0.01;
    fill.position.z = 0.02;
    group.add(back);
    group.add(fill);
    parent.add(group);
    return group;
  }

  function addBeam(from, to, color, width = 2) {
    const start = new THREE.Vector3(from.x, from.y, from.z);
    const end = new THREE.Vector3(to.x, to.y, to.z);
    const direction = new THREE.Vector3().subVectors(end, start);
    const length = direction.length();
    if (length < 0.05) return null;

    const geometry = new THREE.CylinderGeometry(0.06, 0.06, length, 6);
    const material = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.95
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.copy(start).add(end).multiplyScalar(0.5);
    mesh.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      direction.clone().normalize()
    );
    fxRoot.add(mesh);
    timedFx.push({ mesh, born: performance.now(), life: 900 });

    // 補助の線も残す
    const lineGeom = new THREE.BufferGeometry().setFromPoints([start, end]);
    const line = new THREE.Line(lineGeom, new THREE.LineBasicMaterial({ color }));
    fxRoot.add(line);
    timedFx.push({ mesh: line, born: performance.now(), life: 900 });
    return mesh;
  }

  function addBurst(at, color, size = 0.45) {
    const mesh = addBox(fxRoot, at.x, at.y, at.z, size, size, size, color, 0.85);
    timedFx.push({ mesh, born: performance.now(), life: 700, rise: 0.004 });
    return mesh;
  }

  function addFloatText(at, text, color) {
    const sprite = makeLabelSprite([text], {
      width: 160,
      height: 64,
      scale: 1.4,
      color,
      font: 'bold 36px sans-serif',
      bg: 'rgba(0,0,0,0.45)'
    });
    sprite.position.set(at.x, at.y, at.z);
    fxRoot.add(sprite);
    timedFx.push({ mesh: sprite, born: performance.now(), life: 1100, rise: 0.0035 });
  }

  function sync(state, decision, events = {}) {
    clearGroup(root);
    if (!state) return;

    const blockKey = new Set();
    for (const block of state.blocks || []) {
      const key = `${block.x},${block.y},${block.z}`;
      if (blockKey.has(key)) continue;
      blockKey.add(key);
      const color = block.y === 0 ? 0x3f4f3a : 0x64748b;
      addBox(root, block.x + 0.5, block.y + 0.5, block.z + 0.5, 0.98, 0.98, 0.98, color);
    }

    const botColor = events.botDead || state.botDead || state.bot.hp <= 0
      ? 0x64748b
      : (events.botHurt ? 0xf87171 : (decision?.movement === 'attack' ? 0xfbbf24 : 0x34d399));
    const botMesh = addBox(
      root,
      state.bot.x,
      (events.botDead || state.botDead || state.bot.hp <= 0) ? state.bot.y + 0.35 : state.bot.y + 0.9,
      state.bot.z,
      (events.botDead || state.botDead || state.bot.hp <= 0) ? 1.6 : 0.7,
      (events.botDead || state.botDead || state.bot.hp <= 0) ? 0.5 : 1.8,
      0.7,
      botColor
    );
    if (events.botDead || state.botDead || state.bot.hp <= 0) {
      botMesh.rotation.z = Math.PI / 2;
    }
    addHpBar(root, state.bot.x, state.bot.y + 2.35, state.bot.z, Math.max(0, state.bot.hp ?? 0) / 20);
    const botLabel = makeLabelSprite([
      (events.botDead || state.botDead || state.bot.hp <= 0)
        ? '相棒 死亡'
        : `相棒 HP${Math.max(0, Math.round(state.bot.hp ?? 0))}`
    ], {
      width: 220,
      height: 64,
      scale: 1.8,
      color: (events.botDead || state.botDead || state.bot.hp <= 0) ? '#fca5a5' : '#86efac'
    });
    botLabel.position.set(state.bot.x, state.bot.y + 2.85, state.bot.z);
    root.add(botLabel);

    if (state.owner) {
      addBox(root, state.owner.x, state.owner.y + 0.9, state.owner.z, 0.65, 1.8, 0.65, 0x60a5fa);
      const ownerLabel = makeLabelSprite(['オーナー'], {
        width: 160,
        height: 56,
        scale: 1.5,
        color: '#93c5fd'
      });
      ownerLabel.position.set(state.owner.x, state.owner.y + 2.5, state.owner.z);
      root.add(ownerLabel);
    }

    const primary = state.enemies.find((enemy) => enemy.id === decision?.primaryId);
    for (const enemy of state.enemies || []) {
      const isPrimary = enemy.id === decision?.primaryId;
      const base = ENEMY_COLORS[enemy.kind] || 0xef4444;
      const fuseStarted = enemy.fuseStartedAt != null;
      const fuseProgress = fuseStarted
        ? Math.max(0, Math.min(1, (Number(state.now) - Number(enemy.fuseStartedAt)) / 1500))
        : 0;
      // JEの膨らみ: 進行に応じてサイズアップ＋点滅
      const swell = fuseStarted ? 1 + fuseProgress * 0.55 : 1;
      const flash = fuseStarted && Math.floor(fuseProgress * 12) % 2 === 1;
      const color = flash ? 0xffffff : (fuseStarted ? 0xfef08a : base);
      const bw = (isPrimary ? 0.85 : 0.7) * swell;
      const bh = 1.8 * swell;
      const bd = (isPrimary ? 0.85 : 0.7) * swell;
      addBox(root, enemy.x, enemy.y + bh / 2, enemy.z, bw, bh, bd, color);
      addHpBar(root, enemy.x, enemy.y + bh + 0.55, enemy.z, (enemy.hp ?? 0) / 20, isPrimary ? 1.35 : 1.1);
      const tags = fuseStarted
        ? [`${enemy.kind} 着火 ${Math.round(fuseProgress * 100)}%`, `HP${Math.max(0, Math.round(enemy.hp ?? 0))}`]
        : [`${enemy.kind}`, `HP${Math.max(0, Math.round(enemy.hp ?? 0))}`];
      const label = makeLabelSprite(
        tags,
        {
          width: 220,
          height: 88,
          scale: 1.7,
          color: fuseStarted ? '#fef08a' : (isPrimary ? '#fde68a' : '#fecaca')
        }
      );
      label.position.set(enemy.x, enemy.y + bh + 1.15, enemy.z);
      root.add(label);
      if (isPrimary) {
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(0.7, 0.9, 24),
          new THREE.MeshBasicMaterial({ color: 0xfacc15, side: THREE.DoubleSide, transparent: true, opacity: 0.85 })
        );
        ring.rotation.x = -Math.PI / 2;
        ring.position.set(enemy.x, enemy.y + 0.05, enemy.z);
        root.add(ring);
      }
    }

    if (decision?.destination && !state.botDead && state.bot.hp > 0 && decision.movement !== 'dead') {
      const color = MOVE_COLORS[decision.movement] || 0xfacc15;
      const points = [
        new THREE.Vector3(state.bot.x, state.bot.y + 1.1, state.bot.z),
        new THREE.Vector3(
          decision.destination.x,
          (decision.destination.y ?? state.bot.y) + 1.1,
          decision.destination.z
        )
      ];
      const geometry = new THREE.BufferGeometry().setFromPoints(points);
      const material = new THREE.LineDashedMaterial({ color, dashSize: 0.35, gapSize: 0.2 });
      const line = new THREE.Line(geometry, material);
      line.computeLineDistances();
      root.add(line);
      addBox(
        root,
        decision.destination.x,
        (decision.destination.y ?? state.bot.y) + 0.15,
        decision.destination.z,
        0.35,
        0.3,
        0.35,
        color,
        0.9
      );
    }

    // 安全点／接近点への直線プレビュー
    const route = decision?.routePreview;
    if (route?.points?.length >= 2 && !state.botDead && state.bot.hp > 0) {
      const routeColor = 0x67e8f9;
      const routePoints = route.points.map((point) => new THREE.Vector3(
        point.x,
        (point.y ?? state.bot.y) + 0.22,
        point.z
      ));
      const routeGeom = new THREE.BufferGeometry().setFromPoints(routePoints);
      const routeMat = new THREE.LineBasicMaterial({
        color: routeColor,
        transparent: true,
        opacity: 0.95
      });
      root.add(new THREE.Line(routeGeom, routeMat));
      if (route.goal) {
        addBox(
          root,
          route.goal.x,
          (route.goal.y ?? state.bot.y) + 0.2,
          route.goal.z,
          0.45,
          0.35,
          0.45,
          0xf0abfc,
          0.9
        );
        const goalLabel = makeLabelSprite(['移動目標'], {
          width: 140,
          height: 48,
          scale: 1.35,
          color: '#f5d0fe'
        });
        goalLabel.position.set(
          route.goal.x,
          (route.goal.y ?? state.bot.y) + 1.4,
          route.goal.z
        );
        root.add(goalLabel);
      }
    }

    // 攻撃扇＋遮蔽影＋安全地帯
    const safeDebug = decision?.safeZoneDebug;
    if (safeDebug && !state.botDead && state.bot.hp > 0) {
      if (safeDebug.safeZone) {
        addBox(
          root,
          safeDebug.safeZone.x,
          (safeDebug.safeZone.y ?? state.bot.y) + 0.25,
          safeDebug.safeZone.z,
          0.55,
          0.4,
          0.55,
          0x4ade80,
          0.95
        );
        const safeLabel = makeLabelSprite(['安全地帯'], {
          width: 160,
          height: 48,
          scale: 1.4,
          color: '#bbf7d0'
        });
        safeLabel.position.set(
          safeDebug.safeZone.x,
          (safeDebug.safeZone.y ?? state.bot.y) + 1.55,
          safeDebug.safeZone.z
        );
        root.add(safeLabel);
      }
      if (safeDebug.coverPoint) {
        addBox(
          root,
          safeDebug.coverPoint.x,
          (safeDebug.coverPoint.y ?? state.bot.y) + 0.35,
          safeDebug.coverPoint.z,
          0.4,
          0.55,
          0.4,
          0x86efac,
          0.75
        );
      }
      for (const fan of safeDebug.fans || []) {
        if (!fan?.apex) continue;
        const isRanged = fan.enemyClass === 'ranged';
        const coverDist = fan.coverPoint
          ? Math.hypot(fan.coverPoint.x - fan.apex.x, fan.coverPoint.z - fan.apex.z)
          : null;
        // 遮蔽がある遠距離扇は「危険＝遮蔽まで」。その先を橙で塗ると影が危険に見える。
        const dangerLen = (fan.blocked && coverDist != null && coverDist > 0.4)
          ? Math.min(fan.radius || 5, coverDist)
          : (fan.radius || 5);
        const y = (fan.apex.y ?? 1) + 0.12;
        const edgeColor = fan.blocked
          ? 0xf97316
          : (isRanged ? 0xf97316 : 0xfbbf24);
        const midColor = fan.exposed
          ? 0xef4444
          : (fan.blocked ? 0xf97316 : (isRanged ? 0xfb923c : 0xfde68a));
        const ray = (bearing, color, length, opacity = 0.9) => {
          const end = new THREE.Vector3(
            fan.apex.x + Math.sin(bearing) * length,
            y,
            fan.apex.z + Math.cos(bearing) * length
          );
          const geom = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(fan.apex.x, y, fan.apex.z),
            end
          ]);
          root.add(new THREE.Line(geom, new THREE.LineBasicMaterial({
            color,
            transparent: true,
            opacity
          })));
        };
        ray(fan.leftRad, edgeColor, dangerLen);
        ray(fan.rightRad, edgeColor, dangerLen);
        ray(fan.midRad, midColor, dangerLen, fan.blocked ? 0.7 : 0.9);
        const half = Math.max(0.05, fan.halfAngle || 0.2);
        const arcPts = [];
        const samples = Math.max(8, Math.ceil((half * 2) / 0.08));
        for (let index = 0; index <= samples; index += 1) {
          const t = index / samples;
          const bearing = fan.midRad - half + (half * 2) * t;
          arcPts.push(new THREE.Vector3(
            fan.apex.x + Math.sin(bearing) * dangerLen * 0.92,
            y,
            fan.apex.z + Math.cos(bearing) * dangerLen * 0.92
          ));
        }
        if (arcPts.length >= 2) {
          const arcGeom = new THREE.BufferGeometry().setFromPoints(arcPts);
          root.add(new THREE.Line(arcGeom, new THREE.LineBasicMaterial({
            color: edgeColor,
            transparent: true,
            opacity: fan.blocked ? 0.55 : 0.85
          })));
        }
        // 遮蔽影: カバー点 → 安全地帯（緑）。扇の先へ伸ばさない。
        if (fan.blocked && fan.coverPoint) {
          const shadowTarget = safeDebug.safeZone
            ? new THREE.Vector3(
              safeDebug.safeZone.x,
              y,
              safeDebug.safeZone.z
            )
            : new THREE.Vector3(
              fan.coverPoint.x + Math.sin(fan.midRad) * 1.55,
              y,
              fan.coverPoint.z + Math.cos(fan.midRad) * 1.55
            );
          const cover = new THREE.Vector3(
            fan.coverPoint.x,
            y,
            fan.coverPoint.z
          );
          const shadowGeom = new THREE.BufferGeometry().setFromPoints([cover, shadowTarget]);
          const shadowLine = new THREE.Line(shadowGeom, new THREE.LineDashedMaterial({
            color: 0x4ade80,
            transparent: true,
            opacity: 0.85,
            dashSize: 0.35,
            gapSize: 0.2
          }));
          shadowLine.computeLineDistances();
          root.add(shadowLine);
        }
      }
    }

    // 近接攻撃エフェクト（生存時のみ）
    if (!state.botDead && state.bot.hp > 0 && decision?.movement === 'attack' && primary) {
      addBeam(
        { x: state.bot.x, y: state.bot.y + 1.2, z: state.bot.z },
        { x: primary.x, y: primary.y + 1.2, z: primary.z },
        0xf97316
      );
      addBurst({ x: primary.x, y: primary.y + 1.3, z: primary.z }, 0xfbbf24, 0.55);
      if (events.botAttacked) {
        addFloatText({ x: primary.x, y: primary.y + 2.2, z: primary.z }, '-4', '#fdba74');
      }
    }

    // 敵の射撃（発射フラッシュ）と飛行中の矢
    for (const motion of decision?.enemyMotions || []) {
      if (!motion.fired) continue;
      const enemy = state.enemies.find((item) => item.id === motion.id) || motion.to;
      let targetPos = { x: state.bot.x, y: state.bot.y + 1.4, z: state.bot.z };
      let beamColor = 0xfbbf24;
      let burstColor = 0xf87171;
      if (motion.hitKind === 'enemy' && motion.hitEntityId != null) {
        const victim = state.enemies.find((item) => item.id === motion.hitEntityId)
          || { x: motion.to?.x, y: motion.to?.y, z: motion.to?.z };
        if (victim && Number.isFinite(victim.x)) {
          targetPos = { x: victim.x, y: (victim.y ?? 1) + 1.2, z: victim.z };
        }
        beamColor = 0xf472b6;
        burstColor = 0xfb7185;
      } else if (motion.hitKind === 'block') {
        targetPos = {
          x: enemy.x + (state.bot.x - enemy.x) * 0.45,
          y: ((enemy.y ?? 1) + state.bot.y) * 0.5 + 1.2,
          z: enemy.z + (state.bot.z - enemy.z) * 0.45
        };
        beamColor = 0x94a3b8;
        burstColor = 0xcbd5e1;
      } else if (!motion.hitKind) {
        // 未着弾: 短い発射線のみ（相棒まで伸ばさない）
        targetPos = {
          x: enemy.x + (state.bot.x - enemy.x) * 0.2,
          y: ((enemy.y ?? 1) + state.bot.y) * 0.5 + 1.3,
          z: enemy.z + (state.bot.z - enemy.z) * 0.2
        };
        beamColor = 0xfde68a;
        burstColor = 0xfbbf24;
      }
      addBeam(
        { x: enemy.x, y: (enemy.y ?? 1) + 1.4, z: enemy.z },
        targetPos,
        beamColor
      );
      if (motion.hitKind) addBurst(targetPos, burstColor, 0.4);
    }
    for (const arrow of state.projectiles || []) {
      addBox(root, arrow.x, arrow.y, arrow.z, 0.22, 0.22, 0.22, 0xfde68a, 0.95);
      addBeam(
        {
          x: arrow.x - arrow.dirX * 0.6,
          y: arrow.y - arrow.dirY * 0.6,
          z: arrow.z - arrow.dirZ * 0.6
        },
        { x: arrow.x, y: arrow.y, z: arrow.z },
        0xfbbf24
      );
    }

    if (events.damageDelta > 0) {
      addFloatText(
        { x: state.bot.x, y: state.bot.y + 2.4, z: state.bot.z },
        `-${events.damageDelta}`,
        '#fca5a5'
      );
      addBurst({ x: state.bot.x, y: state.bot.y + 1.1, z: state.bot.z }, 0xef4444, 0.5);
    }

    // 相棒位置は常に覚え、追従オンのときだけ注視を更新（オフ時はカメラ固定）
    lastBotLook = { x: state.bot.x, y: state.bot.y + 1, z: state.bot.z };
    if (followBot) {
      controls.target.set(lastBotLook.x, lastBotLook.y, lastBotLook.z);
    }
  }

  function setFollowBot(enabled) {
    followBot = Boolean(enabled);
    if (followBot && lastBotLook) {
      controls.target.set(lastBotLook.x, lastBotLook.y, lastBotLook.z);
    }
    return followBot;
  }

  function getFollowBot() {
    return followBot;
  }

  function pickGround(clientX, clientY) {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hit = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(groundPlane, hit)) return null;
    return {
      x: Math.round(hit.x * 4) / 4,
      z: Math.round(hit.z * 4) / 4
    };
  }

  function frame(now) {
    controls.update();
    timedFx = timedFx.filter((item) => {
      const age = now - item.born;
      if (age > item.life) {
        fxRoot.remove(item.mesh);
        disposeObject(item.mesh);
        return false;
      }
      const fade = 1 - age / item.life;
      if (item.rise) item.mesh.position.y += item.rise * 16;
      const mat = item.mesh.material;
      if (mat && 'opacity' in mat) {
        mat.transparent = true;
        mat.opacity = Math.max(0, fade);
      }
      return true;
    });
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }

  resize();
  requestAnimationFrame(frame);
  window.addEventListener('resize', resize);

  return {
    sync,
    pickGround,
    canvas: renderer.domElement,
    resize,
    setFollowBot,
    getFollowBot
  };
}
