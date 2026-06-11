/**
 * 可嵌入粒子场景 (particle-scene.js)
 * ------------------------------------------------------------------
 * 从 web/pointcloud-demo 抽取重构而来：实体鱼灯 ⇄ 粒子鱼影 的溶解互动，
 * 含 5 种解体 FX 与手掌跟随物理。改造要点（对照原 demo）：
 *   - 不再假设满屏：渲染器尺寸跟随传入的 container，监听 container 尺寸变化
 *   - 不再污染全局 / 不再自带 RAF：由宿主每帧调用 update(dt, handData)
 *   - 不再独立开摄像头：手势数据由宿主（统一手势总线）传入
 *   - 提供完整 dispose()：释放 geometry/material/texture/composer/renderer，
 *     避免阶段切换 / 模型切换造成显存泄漏
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';

const particleVS = /* glsl */`
    uniform float uTime;
    uniform float uSize;
    uniform float uDissolve;
    uniform float uSaturation;
    uniform int uFxMode;
    uniform vec3 uHandPos;
    uniform float uHandActive;

    attribute vec3 aColor;
    attribute float aRandom;
    attribute vec3 aOrigPos;

    varying vec3 vColor;
    varying float vRawFactor;
    varying float vTrail;

    vec3 adjustSat(vec3 c, float s) { float g = dot(c, vec3(0.299,0.587,0.114)); return mix(vec3(g), c, s); }

    vec3 mod289(vec3 x){return x-floor(x*(1./289.))*289.;}
    vec4 mod289(vec4 x){return x-floor(x*(1./289.))*289.;}
    vec4 permute(vec4 x){return mod289(((x*34.)+1.)*x);}
    vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-.85373472095314*r;}
    float snoise(vec3 v){
        const vec2 C=vec2(1./6.,1./3.);const vec4 D=vec4(0.,.5,1.,2.);
        vec3 i=floor(v+dot(v,C.yyy));vec3 x0=v-i+dot(i,C.xxx);
        vec3 g=step(x0.yzx,x0.xyz);vec3 l=1.-g;
        vec3 i1=min(g,l.zxy);vec3 i2=max(g,l.zxy);
        vec3 x1=x0-i1+C.xxx;vec3 x2=x0-i2+C.yyy;vec3 x3=x0-D.yyy;
        i=mod289(i);
        vec4 p=permute(permute(permute(i.z+vec4(0.,i1.z,i2.z,1.))+i.y+vec4(0.,i1.y,i2.y,1.))+i.x+vec4(0.,i1.x,i2.x,1.));
        float n_=.142857142857;vec3 ns=n_*D.wyz-D.xzx;
        vec4 j=p-49.*floor(p*ns.z*ns.z);vec4 x_=floor(j*ns.z);vec4 y_=floor(j-7.*x_);
        vec4 x=x_*ns.x+ns.yyyy;vec4 y=y_*ns.x+ns.yyyy;vec4 h=1.-abs(x)-abs(y);
        vec4 b0=vec4(x.xy,y.xy);vec4 b1=vec4(x.zw,y.zw);
        vec4 s0=floor(b0)*2.+1.;vec4 s1=floor(b1)*2.+1.;
        vec4 sh=-step(h,vec4(0.));
        vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
        vec3 p0=vec3(a0.xy,h.x);vec3 p1=vec3(a0.zw,h.y);vec3 p2=vec3(a1.xy,h.z);vec3 p3=vec3(a1.zw,h.w);
        vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
        p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;
        vec4 m=max(.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.);m=m*m;
        return 42.*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
    }
    vec3 curlNoise(vec3 p){float e=.1;return normalize(vec3(snoise(p+vec3(0,e,0))-snoise(p-vec3(0,e,0))-snoise(p+vec3(0,0,e))+snoise(p-vec3(0,0,e)),snoise(p+vec3(0,0,e))-snoise(p-vec3(0,0,e))-snoise(p+vec3(e,0,0))+snoise(p-vec3(e,0,0)),snoise(p+vec3(e,0,0))-snoise(p-vec3(e,0,0))-snoise(p+vec3(0,e,0))+snoise(p-vec3(0,e,0))));}

    void main() {
        vColor = adjustSat(aColor, uSaturation);
        vec3 pos = aOrigPos;
        float rnd = aRandom;

        pos *= 1.0 + sin(uTime * 1.3 + rnd * 6.28) * 0.004;

        float dispProgress = smoothstep(0.35, 1.0, uDissolve);
        float rawFactor = 0.0;
        float trailStrength = 0.0;

        if (dispProgress > 0.005) {
            float noiseScale = uFxMode == 1 ? 0.08 : (uFxMode == 2 ? 0.04 : 0.05);
            float edgeNoise = snoise(pos * noiseScale + uTime * 0.06) * 0.5 + 0.5;
            rawFactor = smoothstep(edgeNoise - 0.15, edgeNoise + 0.15, dispProgress);

            if (uFxMode == 0) {
                vec3 flow = curlNoise(pos * 0.02 + uTime * 0.1);
                vec3 dir = mix(normalize(pos + 0.001), flow, 0.5);
                pos += dir * rawFactor * (40.0 + rnd * 80.0);
                pos.y -= rawFactor * rawFactor * 15.0;
                trailStrength = rawFactor * 0.5;
            } else if (uFxMode == 1) {
                vec3 dir = normalize(pos + vec3(rnd * 0.1 - 0.05));
                float power = rawFactor * rawFactor * (80.0 + rnd * 120.0);
                pos += dir * power;
                pos.y -= rawFactor * rawFactor * 20.0;
                float burst2 = smoothstep(0.4, 0.7, rawFactor);
                pos += vec3(sin(rnd*62.8), cos(rnd*31.4), sin(rnd*94.2)) * burst2 * 30.0;
                trailStrength = rawFactor * 0.9;
            } else if (uFxMode == 2) {
                float origRadius = length(pos.xz);
                float angle = uTime * (0.8 + rnd * 0.4) + atan(pos.z, pos.x) + rawFactor * 3.0;
                float expandRadius = origRadius + rawFactor * rawFactor * (20.0 + rnd * 40.0);
                pos.x = cos(angle) * expandRadius;
                pos.z = sin(angle) * expandRadius;
                pos.y += rawFactor * rawFactor * (15.0 + rnd * 25.0);
                vec3 vortexFlow = curlNoise(pos * 0.02 + uTime * 0.12);
                pos += vortexFlow * rawFactor * 8.0;
                trailStrength = rawFactor * 0.7;
            } else if (uFxMode == 3) {
                vec3 outDir = normalize(pos + vec3(rnd * 0.2 - 0.1, rnd * 0.1, rnd * 0.2 - 0.1));
                pos += outDir * rawFactor * (25.0 + rnd * 50.0);
                float floatPhase = uTime * (0.8 + rnd * 1.2) + rnd * 6.28;
                pos.y += sin(floatPhase) * rawFactor * (8.0 + rnd * 5.0);
                pos.x += cos(floatPhase * 0.7) * rawFactor * 4.0;
                pos.z += sin(floatPhase * 0.5 + 2.0) * rawFactor * 4.0;
                trailStrength = rawFactor * 0.4;
            } else if (uFxMode == 4) {
                vec3 flow = curlNoise(pos * 0.018 + uTime * 0.1);
                pos += flow * rawFactor * 15.0;
                pos.y += rawFactor * (10.0 + rnd * 15.0);
                float spiralT = uTime * (1.0 + rnd * 0.8) + rnd * 6.28;
                float spiralR = rawFactor * (5.0 + rnd * 15.0);
                pos.x += cos(spiralT) * spiralR;
                pos.z += sin(spiralT) * spiralR;
                vec3 outward = normalize(pos + 0.001) * rawFactor * rawFactor * 20.0;
                pos += outward;
                trailStrength = rawFactor * 0.6;
            }
        }

        if (uHandActive > 0.5 && uDissolve > 0.08) {
            float followStrength = smoothstep(0.08, 0.5, uDissolve);
            vec3 toHand = uHandPos - pos;
            float distToHand = length(toHand) + 0.001;
            vec3 dirToHand = toHand / distToHand;
            float influence = 1.0 / (1.0 + distToHand * 0.02);
            float attractForce = influence * followStrength * (3.0 + rawFactor * 8.0);
            pos += dirToHand * attractForce;
            vec3 flowSeed = (pos - uHandPos) * 0.03 + uTime * 0.2;
            vec3 flowDir = curlNoise(flowSeed);
            float flowForce = influence * followStrength * (5.0 + rawFactor * 15.0);
            pos += flowDir * flowForce;
            float orbitAngle = uTime * (1.2 + rnd * 0.8) + rnd * 6.28;
            float orbitRadius = influence * followStrength * (2.0 + rawFactor * 6.0);
            pos.x += cos(orbitAngle) * orbitRadius;
            pos.z += sin(orbitAngle) * orbitRadius;
            pos.y += sin(orbitAngle * 0.7) * orbitRadius * 0.5;
        }

        vRawFactor = rawFactor;
        vTrail = trailStrength;

        vec4 mv = modelViewMatrix * vec4(pos, 1.0);
        float sizeMul = 1.0 + rawFactor * (uFxMode == 1 ? 2.0 : 1.2);
        gl_PointSize = uSize * sizeMul * (200.0 / -mv.z);
        gl_Position = projectionMatrix * mv;
    }
`;

const particleFS = /* glsl */`
    uniform float uDissolve;
    uniform int uFxMode;

    varying vec3 vColor;
    varying float vRawFactor;
    varying float vTrail;

    void main() {
        if (length(vColor) < 0.05) discard;
        vec2 coord = gl_PointCoord - vec2(0.5);
        float stretch = 1.0 + vTrail * 1.5;
        coord.y *= stretch;
        float r2 = dot(coord, coord);
        if (r2 > 0.25) discard;
        float dist = sqrt(r2) * 2.0;
        float edgeFade = 1.0 - smoothstep(0.4, 1.0, dist);
        vec3 rgb = vColor;
        if (vRawFactor > 0.01) {
            vec3 glowColor;
            if (uFxMode == 1) glowColor = mix(vec3(1.0, 0.4, 0.0), vec3(1.0, 1.0, 0.6), vRawFactor);
            else if (uFxMode == 2) glowColor = mix(vec3(0.2, 0.5, 1.0), vec3(0.8, 0.3, 1.0), vRawFactor);
            else if (uFxMode == 3) glowColor = mix(vec3(0.4, 1.0, 0.3), vec3(1.0, 0.95, 0.4), vRawFactor);
            else if (uFxMode == 4) glowColor = mix(vec3(0.6, 0.4, 1.0), vec3(1.0, 0.8, 0.9), vRawFactor);
            else glowColor = mix(vec3(1.0, 0.7, 0.2), vec3(0.3, 0.6, 1.0), vRawFactor);
            float eg = smoothstep(0.0, 0.2, vRawFactor) * (1.0 - smoothstep(0.7, 1.0, vRawFactor));
            rgb = mix(rgb, glowColor, eg * 0.2);
            rgb += glowColor * eg * 0.2;
        }
        float fadeMultiplier = 1.0 - smoothstep(0.65, 1.0, vRawFactor) * 0.5;
        float alpha = edgeFade * 0.55 * fadeMultiplier;
        gl_FragColor = vec4(rgb, alpha);
    }
`;

export class ParticleScene {
    constructor(container, opts = {}) {
        this.container = container;
        this.opts = Object.assign(
            { particleSize: 2.2, saturation: 1.3, handDrivesDissolve: true, autoRotate: true, viewShiftFrac: 0 },
            opts
        );
        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.composer = null;
        this.bloomPass = null;
        this.controls = null;
        this.loader = new GLTFLoader();
        this.clock = new THREE.Clock();

        this.solidModel = null;
        this.particles = null;
        this.particleUniforms = null;
        this.dissolveValue = 0;
        this.currentFx = 0;
        this._smoothedDissolve = 0;
        this._manualUntil = 0;     // 滑块手动控制时，暂停"无手回归"衰减
        this._handVec = new THREE.Vector3();
        this._inited = false;
        this._sizePx = { w: 0, h: 0 };
    }

    // 滑块手动设置溶解度：保持几秒不被"无手回归实体"覆盖
    setDissolveManual(v) {
        this.setDissolve(v);
        this._smoothedDissolve = this.dissolveValue;
        this._manualUntil = (typeof performance !== 'undefined' ? performance.now() : 0) + 5000;
    }

    // 把主体向左偏移（给右侧知识卡片让位）：用 setViewOffset 平移视锥，右侧多出的区域显示深色背景
    _applyViewShift(w, h) {
        const frac = this.opts.viewShiftFrac || 0;
        if (frac) this.camera.setViewOffset(w, h, w * frac, 0, w, h);
        else this.camera.clearViewOffset();
        this.camera.updateProjectionMatrix();
    }

    _size() {
        const w = this.container.clientWidth || window.innerWidth;
        const h = this.container.clientHeight || window.innerHeight;
        return { w, h };
    }

    async init() {
        if (this._inited) return;
        const { w, h } = this._size();

        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 2000);
        this.camera.position.set(0, 0, 180);
        this._applyViewShift(w, h);

        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        this.renderer.setSize(w, h);
        // 性能分级：移动/触摸(粗指针)设备降采样，避免 8 万粒子炸帧
        const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, coarse ? 1.5 : 2));
        this.renderer.setClearColor(0x050508, this.opts.transparentBg ? 0 : 1);
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 1.8;
        this.renderer.domElement.style.cssText = 'width:100%;height:100%;display:block;';
        this.container.appendChild(this.renderer.domElement);

        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.08;
        this.controls.autoRotate = this.opts.autoRotate;
        this.controls.autoRotateSpeed = 1.5;

        const ambient = new THREE.AmbientLight(0xffffff, 2.5); this.scene.add(ambient);
        const d1 = new THREE.DirectionalLight(0xfff0dd, 2.5); d1.position.set(5, 10, 7); this.scene.add(d1);
        const d2 = new THREE.DirectionalLight(0xffe8cc, 2.0); d2.position.set(-5, 5, -3); this.scene.add(d2);
        const rim = new THREE.DirectionalLight(0xaaccff, 1.5); rim.position.set(-3, -5, -5); this.scene.add(rim);
        const fill = new THREE.DirectionalLight(0xffffff, 1.2); fill.position.set(0, -5, 10); this.scene.add(fill);
        const top = new THREE.DirectionalLight(0xffffff, 1.0); top.position.set(0, 10, 0); this.scene.add(top);

        this.composer = new EffectComposer(this.renderer);
        this.composer.addPass(new RenderPass(this.scene, this.camera));
        this.bloomPass = new UnrealBloomPass(new THREE.Vector2(w, h), 0.15, 0.4, 0.6);
        this.composer.addPass(this.bloomPass);

        this._sizePx = { w, h };
        this._inited = true;
    }

    async loadModel(url) {
        if (!this._inited) await this.init();

        this._disposeModel();

        const gltf = await this.loader.loadAsync(url.includes('%') ? url : encodeURI(url));
        const model = gltf.scene;

        const box = new THREE.Box3().setFromObject(model);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z) || 1;
        const scale = 70 / maxDim;
        model.position.sub(center).multiplyScalar(scale);
        model.scale.setScalar(scale);
        this.solidModel = model;
        this.scene.add(model);

        const dissolveUniform = { value: 0 };
        model.traverse((child) => {
            if (!child.isMesh) return;
            child.material.transparent = true;
            child.material.onBeforeCompile = (shader) => {
                shader.uniforms.uModelDissolve = dissolveUniform;
                shader.vertexShader = shader.vertexShader.replace(
                    '#include <common>',
                    '#include <common>\n varying vec3 vWorldPos;'
                );
                shader.vertexShader = shader.vertexShader.replace(
                    '#include <worldpos_vertex>',
                    '#include <worldpos_vertex>\n vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;'
                );
                shader.fragmentShader = shader.fragmentShader.replace(
                    '#include <common>',
                    `#include <common>
                    uniform float uModelDissolve;
                    varying vec3 vWorldPos;
                    float hash3d(vec3 p){p=fract(p*vec3(443.8975,397.2973,491.1871));p+=dot(p,p.yzx+19.19);return fract((p.x+p.y)*p.z);}
                    float valueNoise(vec3 p){vec3 i=floor(p);vec3 f=fract(p);f=f*f*(3.0-2.0*f);
                    float a=hash3d(i),b=hash3d(i+vec3(1,0,0)),c=hash3d(i+vec3(0,1,0)),d=hash3d(i+vec3(1,1,0));
                    float e=hash3d(i+vec3(0,0,1)),ff=hash3d(i+vec3(1,0,1)),g=hash3d(i+vec3(0,1,1)),h=hash3d(i+vec3(1,1,1));
                    return mix(mix(mix(a,b,f.x),mix(c,d,f.x),f.y),mix(mix(e,ff,f.x),mix(g,h,f.x),f.y),f.z);}`
                );
                shader.fragmentShader = shader.fragmentShader.replace(
                    '#include <dithering_fragment>',
                    `#include <dithering_fragment>
                    if (uModelDissolve > 0.005) {
                        float n = valueNoise(vWorldPos * 0.05);
                        float threshold = uModelDissolve * 1.4 - 0.2;
                        if (n < threshold) discard;
                        float edge = 1.0 - smoothstep(threshold, threshold + 0.08, n);
                        gl_FragColor.rgb += vec3(1.0, 0.7, 0.2) * edge * 1.5;
                    }`
                );
            };
            child.material.needsUpdate = true;
        });
        model._dissolveUniform = dissolveUniform;

        this._buildParticles(model);

        this.dissolveValue = 0;
        this._smoothedDissolve = 0;
        this.solidModel.visible = true;
        this.particles.visible = false;
    }

    _buildParticles(model) {
        const allPositions = [];
        const allColors = [];
        model.traverse((child) => {
            if (!child.isMesh) return;
            const geo = child.geometry;
            const pos = geo.attributes.position;
            const uv = geo.attributes.uv;
            const mat = child.material;
            child.updateWorldMatrix(true, false);
            const worldMatrix = child.matrixWorld;

            let texCtx = null, texW = 0, texH = 0, texData = null;
            if (mat.map && mat.map.image) {
                const img = mat.map.image;
                const c = document.createElement('canvas');
                texW = Math.min(img.width, 1024);
                texH = Math.min(img.height, 1024);
                c.width = texW; c.height = texH;
                texCtx = c.getContext('2d', { willReadFrequently: true });
                texCtx.drawImage(img, 0, 0, texW, texH);
                texData = texCtx.getImageData(0, 0, texW, texH).data;
            }

            const step = Math.max(1, Math.floor(pos.count / 80000));
            const v = new THREE.Vector3();
            for (let i = 0; i < pos.count; i += step) {
                v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(worldMatrix);
                allPositions.push(v.x, v.y, v.z);
                if (texData && uv) {
                    let u = uv.getX(i) % 1; if (u < 0) u += 1;
                    let vv = uv.getY(i) % 1; if (vv < 0) vv += 1;
                    const px = Math.min(Math.floor(u * texW), texW - 1);
                    const py = Math.min(Math.floor((1 - vv) * texH), texH - 1);
                    const idx = (py * texW + px) * 4;
                    allColors.push(texData[idx] / 255, texData[idx + 1] / 255, texData[idx + 2] / 255);
                } else if (mat.color) {
                    allColors.push(mat.color.r, mat.color.g, mat.color.b);
                } else {
                    allColors.push(0.83, 0.69, 0.22);
                }
            }
        });

        const count = allPositions.length / 3;
        const positions = new Float32Array(allPositions);
        const colors = new Float32Array(allColors);
        const origPos = new Float32Array(allPositions);
        const randoms = new Float32Array(count);
        for (let i = 0; i < count; i++) randoms[i] = Math.random();

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geo.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
        geo.setAttribute('aOrigPos', new THREE.BufferAttribute(origPos, 3));
        geo.setAttribute('aRandom', new THREE.BufferAttribute(randoms, 1));

        this.particleUniforms = {
            uTime: { value: 0 },
            uSize: { value: this.opts.particleSize },
            uSaturation: { value: this.opts.saturation },
            uDissolve: { value: 0 },
            uFxMode: { value: this.currentFx },
            uHandPos: { value: new THREE.Vector3(0, 0, 0) },
            uHandActive: { value: 0.0 },
        };
        const mat = new THREE.ShaderMaterial({
            uniforms: this.particleUniforms,
            vertexShader: particleVS,
            fragmentShader: particleFS,
            transparent: true, depthWrite: false, blending: THREE.NormalBlending,
        });
        this.particles = new THREE.Points(geo, mat);
        this.particles.frustumCulled = false;
        this.particles.visible = false;
        this.scene.add(this.particles);
        console.log(`[ParticleScene] 粒子: ${count.toLocaleString()} 点`);
    }

    setFxMode(i) {
        this.currentFx = i | 0;
        if (this.particleUniforms) this.particleUniforms.uFxMode.value = this.currentFx;
    }
    setParticleSize(v) {
        this.opts.particleSize = v;
        if (this.particleUniforms) this.particleUniforms.uSize.value = v;
    }
    setSaturation(v) {
        this.opts.saturation = v;
        if (this.particleUniforms) this.particleUniforms.uSaturation.value = v;
    }

    setDissolve(v) {
        v = Math.max(0, Math.min(1, v));
        this.dissolveValue = v;
        const modelDissolve = Math.min(v * 2.5, 1.0);
        if (v < 0.002) {
            if (this.solidModel) this.solidModel.visible = true;
            if (this.particles) this.particles.visible = false;
        } else if (v < 0.42) {
            if (this.solidModel) {
                this.solidModel.visible = true;
                if (this.solidModel._dissolveUniform) this.solidModel._dissolveUniform.value = modelDissolve;
            }
            if (this.particles) this.particles.visible = true;
        } else {
            if (this.solidModel) this.solidModel.visible = false;
            if (this.particles) this.particles.visible = true;
        }
        if (this.particleUniforms) this.particleUniforms.uDissolve.value = v;
        if (this.bloomPass) this.bloomPass.strength = 0.08 + v * 0.25;
    }

    /** 宿主每帧调用。handData 来自统一手势总线（palmX/palmY ∈ [-1,1] 已镜像, openness ∈ [0,1]）。 */
    update(dt, handData) {
        if (!this._inited) return;

        // 容器尺寸变化（如从隐藏到显示）时同步渲染器
        const { w, h } = this._size();
        if (w > 0 && h > 0 && (w !== this._sizePx.w || h !== this._sizePx.h)) {
            this.renderer.setSize(w, h);
            this.composer.setSize(w, h);
            this.camera.aspect = w / h;
            this._applyViewShift(w, h);   // 重新计算左移视图（含 updateProjectionMatrix）
            this._sizePx = { w, h };
        }

        const elapsed = this.clock.getElapsedTime();
        if (this.particleUniforms) {
            this.particleUniforms.uTime.value = elapsed;
            if (handData && handData.detected) {
                this._handVec.set(handData.palmX * 80, handData.palmY * 60, 0);
                this.particleUniforms.uHandPos.value.copy(this._handVec);
                this.particleUniforms.uHandActive.value = 1.0;
            } else {
                this.particleUniforms.uHandActive.value = 0.0;
            }
        }

        // 手张开度 → 溶解进度（与 pointcloud-demo 一致）：有手时平滑追随张开度（可达 1=完全散开），
        // 无手时缓慢回归实体（更亮、更像 demo 默认态），下次张手再化光
        if (this.opts.handDrivesDissolve) {
            if (handData && handData.detected) {
                // 0.06 ≈ demo 的缓动速率（约1秒完成大部分过渡），避免"太快"
                this._smoothedDissolve += (handData.openness - this._smoothedDissolve) * 0.06;
                this.setDissolve(this._smoothedDissolve);
                if (this.controls) this.controls.autoRotateSpeed = handData.palmX * 4;
            } else if (this.dissolveValue > 0.001 && (typeof performance === 'undefined' || performance.now() > this._manualUntil)) {
                this._smoothedDissolve = this.dissolveValue * 0.94;
                this.setDissolve(this._smoothedDissolve < 0.01 ? 0 : this._smoothedDissolve);
                if (this.controls) this.controls.autoRotateSpeed = 1.5;
            }
        }

        if (this.controls) this.controls.update();
        this.composer.render();
    }

    _disposeMaterial(mat) {
        if (!mat) return;
        for (const key of Object.keys(mat)) {
            const val = mat[key];
            if (val && val.isTexture) val.dispose();
        }
        mat.dispose();
    }

    _disposeModel() {
        if (this.solidModel) {
            this.scene.remove(this.solidModel);
            this.solidModel.traverse((child) => {
                if (child.isMesh) {
                    child.geometry?.dispose();
                    if (Array.isArray(child.material)) child.material.forEach((m) => this._disposeMaterial(m));
                    else this._disposeMaterial(child.material);
                }
            });
            this.solidModel = null;
        }
        if (this.particles) {
            this.scene.remove(this.particles);
            this.particles.geometry?.dispose();
            this.particles.material?.dispose();
            this.particles = null;
            this.particleUniforms = null;
        }
    }

    dispose() {
        this._disposeModel();
        if (this.controls) { this.controls.dispose(); this.controls = null; }
        if (this.composer) {
            this.composer.passes?.forEach((p) => p.dispose && p.dispose());
            this.composer = null;
        }
        this.bloomPass = null;
        if (this.renderer) {
            const el = this.renderer.domElement;
            this.renderer.dispose();
            this.renderer.forceContextLoss?.();
            if (el && el.parentNode) el.parentNode.removeChild(el);
            this.renderer = null;
        }
        this.scene = null;
        this.camera = null;
        this._inited = false;
    }
}
