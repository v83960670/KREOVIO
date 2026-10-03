import { useEffect, useRef } from 'react';
import type * as THREE from 'three';

function seeded(index: number) {
  const value = Math.sin((index + 1) * 127.1 + 311.7) * 43758.5453;
  return value - Math.floor(value);
}

function surfacePoint(index: number, count: number, radius: number, THREE: typeof import('three')) {
  const y = 1 - (index / Math.max(1, count - 1)) * 2;
  const ringRadius = Math.sqrt(Math.max(0, 1 - y * y));
  const angle = Math.PI * (3 - Math.sqrt(5)) * index;
  return new THREE.Vector3(Math.cos(angle) * ringRadius * radius, y * radius, Math.sin(angle) * ringRadius * radius);
}

export default function TrendCoreWebGL() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let destroyed = false;
    let frame = 0;
    let renderer: THREE.WebGLRenderer | null = null;
    let scene: THREE.Scene | null = null;
    let camera: THREE.PerspectiveCamera | null = null;
    let signalGroup: THREE.Group | null = null;
    let particleField: THREE.Points | null = null;
    let disposeScene = () => {};
    const pointer = { x: 0, y: 0, targetX: 0, targetY: 0 };

    const render = (time = 0) => {
      if (!renderer || !scene || !camera) return;
      if (signalGroup) {
        pointer.x += (pointer.targetX - pointer.x) * 0.035;
        pointer.y += (pointer.targetY - pointer.y) * 0.035;
        if (!reducedMotion) {
          signalGroup.rotation.y = time * 0.000075 + pointer.x * 0.18;
          signalGroup.rotation.x = -0.18 + pointer.y * 0.15 + Math.sin(time * 0.00016) * 0.025;
          signalGroup.rotation.z = Math.sin(time * 0.00012) * 0.035;
        } else {
          signalGroup.rotation.y = pointer.x * 0.18;
          signalGroup.rotation.x = -0.18 + pointer.y * 0.15;
        }
      }
      if (particleField && !reducedMotion) particleField.rotation.y = -time * 0.000012;
      renderer.render(scene, camera);
      if (!reducedMotion) frame = window.requestAnimationFrame(render);
    };

    const onPointerMove = (event: PointerEvent) => {
      const bounds = canvas.getBoundingClientRect();
      pointer.targetX = ((event.clientX - bounds.left) / Math.max(1, bounds.width) - 0.5) * 2;
      pointer.targetY = ((event.clientY - bounds.top) / Math.max(1, bounds.height) - 0.5) * 2;
      if (reducedMotion) render();
    };
    const onPointerLeave = () => { pointer.targetX = 0; pointer.targetY = 0; if (reducedMotion) render(); };

    const mount = async () => {
      try {
        const THREE = await import('three');
        if (destroyed) return;
        const bounds = canvas.getBoundingClientRect();
        if (!bounds.width || !bounds.height) return;

        renderer = new THREE.WebGLRenderer({
          canvas,
          alpha: true,
          antialias: true,
          powerPreference: 'low-power',
          depth: true,
          stencil: false,
        });
        disposeScene = () => { renderer?.dispose(); canvas.parentElement?.classList.remove('has-webgl'); };
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, window.innerWidth < 620 ? 1.2 : 1.55));
        renderer.setClearColor(0x07090e, 0);
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.05;
        scene = new THREE.Scene();
        scene.fog = new THREE.FogExp2(0x080b13, 0.018);
        camera = new THREE.PerspectiveCamera(39, bounds.width / bounds.height, 0.1, 80);
        camera.position.set(0, 0, window.innerWidth < 620 ? 7.6 : 7.15);
        camera.lookAt(0, 0, 0);
        signalGroup = new THREE.Group();
        scene.add(signalGroup);

        const mobile = window.matchMedia('(max-width: 620px)').matches;
        const nodeCount = mobile ? 240 : 460;
        const pointPositions = new Float32Array(nodeCount * 3);
        const pointColors = new Float32Array(nodeCount * 3);
        const aqua = new THREE.Color('#84ded1');
        const violet = new THREE.Color('#b6a2ff');
        for (let index = 0; index < nodeCount; index += 1) {
          const point = surfacePoint(index, nodeCount, 1.94 + seeded(index) * 0.035, THREE);
          pointPositions.set([point.x, point.y, point.z], index * 3);
          const color = aqua.clone().lerp(violet, seeded(index + 900) * 0.72);
          const intensity = index % 23 === 0 ? 1 : 0.62 + seeded(index + 1700) * 0.25;
          pointColors.set([color.r * intensity, color.g * intensity, color.b * intensity], index * 3);
        }
        const spherePointsGeometry = new THREE.BufferGeometry();
        spherePointsGeometry.setAttribute('position', new THREE.BufferAttribute(pointPositions, 3));
        spherePointsGeometry.setAttribute('color', new THREE.BufferAttribute(pointColors, 3));
        const spherePointsMaterial = new THREE.PointsMaterial({
          size: mobile ? 0.031 : 0.034,
          sizeAttenuation: true,
          vertexColors: true,
          transparent: true,
          opacity: 0.88,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        });
        signalGroup.add(new THREE.Points(spherePointsGeometry, spherePointsMaterial));

        const wireSphere = new THREE.Mesh(
          new THREE.SphereGeometry(1.925, 38, 28),
          new THREE.MeshBasicMaterial({ color: 0x8394cc, wireframe: true, transparent: true, opacity: 0.075, depthWrite: false }),
        );
        signalGroup.add(wireSphere);
        const innerAtmosphere = new THREE.Mesh(
          new THREE.SphereGeometry(1.82, 32, 24),
          new THREE.MeshBasicMaterial({ color: 0x6b66ae, transparent: true, opacity: 0.035, side: THREE.BackSide, depthWrite: false, blending: THREE.AdditiveBlending }),
        );
        signalGroup.add(innerAtmosphere);

        const edgePositions: number[] = [];
        for (let index = 0; index < nodeCount; index += 4) {
          const next = (index + 13) % nodeCount;
          const first = surfacePoint(index, nodeCount, 1.92, THREE);
          const second = surfacePoint(next, nodeCount, 1.92, THREE);
          if (first.distanceTo(second) < 0.62) edgePositions.push(first.x, first.y, first.z, second.x, second.y, second.z);
        }
        const networkGeometry = new THREE.BufferGeometry();
        networkGeometry.setAttribute('position', new THREE.Float32BufferAttribute(edgePositions, 3));
        const networkLines = new THREE.LineSegments(networkGeometry, new THREE.LineBasicMaterial({ color: 0x99a7df, transparent: true, opacity: 0.17, depthWrite: false }));
        signalGroup.add(networkLines);

        const outerRingMaterial = new THREE.MeshBasicMaterial({ color: 0xa994f4, transparent: true, opacity: 0.3, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });
        const orbitOne = new THREE.Mesh(new THREE.TorusGeometry(2.23, 0.0045, 5, 180), outerRingMaterial);
        orbitOne.rotation.set(1.06, 0.1, -0.22);
        signalGroup.add(orbitOne);
        const orbitTwo = new THREE.Mesh(new THREE.TorusGeometry(2.43, 0.003, 5, 180), new THREE.MeshBasicMaterial({ color: 0x8fcfc8, transparent: true, opacity: 0.2, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }));
        orbitTwo.rotation.set(0.72, -0.58, 0.38);
        signalGroup.add(orbitTwo);
        const orbitThree = new THREE.Mesh(new THREE.TorusGeometry(2.03, 0.0027, 4, 160), new THREE.MeshBasicMaterial({ color: 0x919ccb, transparent: true, opacity: 0.12, depthWrite: false, side: THREE.DoubleSide }));
        orbitThree.rotation.set(1.5, 0.7, 0.55);
        signalGroup.add(orbitThree);

        // A few restrained signal trails give the sphere a sense of directional movement.
        const trailColors = [0x8de0d3, 0xb49eff, 0xddb18c];
        const trailStarts = [0.18, 2.28, 4.4];
        trailStarts.forEach((angle, index) => {
          const start = new THREE.Vector3(Math.cos(angle) * 1.45, Math.sin(angle * 1.7) * 0.55, Math.sin(angle) * 1.55);
          const end = new THREE.Vector3(start.x * 1.46 + (index - 1) * 0.18, start.y * 1.55 + 0.22, start.z * 1.46);
          const mid = start.clone().lerp(end, 0.52).add(new THREE.Vector3(0.04, 0.12, 0.07));
          const curve = new THREE.CatmullRomCurve3([start, mid, end]);
          const trail = new THREE.Mesh(
            new THREE.TubeGeometry(curve, 30, 0.0055, 5, false),
            new THREE.MeshBasicMaterial({ color: trailColors[index], transparent: true, opacity: 0.46, depthWrite: false, blending: THREE.AdditiveBlending }),
          );
          signalGroup?.add(trail);
          const signalDot = new THREE.Mesh(
            new THREE.SphereGeometry(0.035, 8, 8),
            new THREE.MeshBasicMaterial({ color: trailColors[index], transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending }),
          );
          signalDot.position.copy(end);
          signalGroup?.add(signalDot);
        });

        const cloudCount = mobile ? 105 : 190;
        const cloudPositions = new Float32Array(cloudCount * 3);
        for (let index = 0; index < cloudCount; index += 1) {
          const point = surfacePoint(index, cloudCount, 2.72 + seeded(index + 2300) * 0.8, THREE);
          cloudPositions.set([point.x, point.y, point.z], index * 3);
        }
        const cloudGeometry = new THREE.BufferGeometry();
        cloudGeometry.setAttribute('position', new THREE.BufferAttribute(cloudPositions, 3));
        const cloudMaterial = new THREE.PointsMaterial({ size: mobile ? 0.017 : 0.019, color: 0x8ea3c9, transparent: true, opacity: 0.43, sizeAttenuation: true, depthWrite: false, blending: THREE.AdditiveBlending });
        particleField = new THREE.Points(cloudGeometry, cloudMaterial);
        scene.add(particleField);

        const resize = () => {
          if (!renderer || !camera) return;
          const next = canvas.getBoundingClientRect();
          if (!next.width || !next.height) return;
          renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, window.innerWidth < 620 ? 1.2 : 1.55));
          renderer.setSize(next.width, next.height, false);
          camera.aspect = next.width / next.height;
          camera.position.z = window.innerWidth < 620 ? 7.6 : 7.15;
          camera.updateProjectionMatrix();
          if (reducedMotion) render();
        };
        const resizeObserver = new ResizeObserver(resize);
        resizeObserver.observe(canvas);
        canvas.addEventListener('pointermove', onPointerMove, { passive: true });
        canvas.addEventListener('pointerleave', onPointerLeave, { passive: true });
        resize();
        canvas.parentElement?.classList.add('has-webgl');
        canvas.dataset.webglReady = 'true';
        disposeScene = () => {
          resizeObserver.disconnect();
          canvas.removeEventListener('pointermove', onPointerMove);
          canvas.removeEventListener('pointerleave', onPointerLeave);
          scene?.traverse((object) => {
            const renderable = object as THREE.Mesh | THREE.Points | THREE.LineSegments;
            if ('geometry' in renderable) renderable.geometry.dispose();
            if ('material' in renderable) {
              const materials = Array.isArray(renderable.material) ? renderable.material : [renderable.material];
              materials.forEach((material) => material.dispose());
            }
          });
          renderer?.dispose();
          canvas.parentElement?.classList.remove('has-webgl');
          delete canvas.dataset.webglReady;
        };
        if (reducedMotion) render();
        else frame = window.requestAnimationFrame(render);
      } catch {
        // WebGL is an enhancement. The accessible lightweight canvas/CSS version remains visible.
      }
    };

    void mount();
    return () => {
      destroyed = true;
      window.cancelAnimationFrame(frame);
      disposeScene();
    };
  }, []);

  return <canvas className="trend-core-webgl" ref={canvasRef} aria-hidden="true" />;
}
