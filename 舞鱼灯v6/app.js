/**
 * 钓一盏鱼灯 - 粒子点云交互系统
 * 核心架构：纹理驱动粒子网格 + 手势控制 + 形态变换 + 鱼群模式
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { WaterRipple } from './water-ripple.js';
import { FISH_TYPES, loadAllFishPointClouds, loadGLBMesh } from './glb-pointcloud.js';
import { applyStippleMaterial } from './mesh-stipple.js';
import { applySwimDeformation, buildSpineRig, attachSpineRig, updateSpineRigs, FishDartController, FishSchool } from './fish-swim.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { BubbleSystem, SplashSystem, CausticsEffect } from './water-effects.js';
import { startHandInput, pauseHandInput, resumeHandInput, handData as sharedHandData } from './src/hand-input.js';
import { ParticleScene } from './src/particle-scene.js';
import { CRAFT_INDEX_TO_PARTICLE, HIGH_DETAIL_LANTERN_MODELS } from './src/fish-manifest.js';
import { rod } from './serial.js';  // Arduino 钓竿编码器通信

// ═══════════════════════════════════════════════════════
// 配置
// ═══════════════════════════════════════════════════════
const CONFIG = {
    particleGrid: 256,        // 256×256 = 65536 粒子（备用morph）
    texSize: 256,             // 数据纹理尺寸（须与 particleGrid 一致）
    pointSize: 3.0,
    bgColor: 0x080810,
    cameraZ: 160,
    morphDuration: 4.0,       // 形态切换秒数（TD风格需要足够时间展示粒子飞散）
    boidsCount: 600,          // 鱼群数量
    finalModelUrl: 'assets/models/浮金鱼影tripo.glb',
};

const DEFAULTS = {
    pointSize: 5.0,
    relief: 0.0,
    fluidStrength: 0.0,
    breathAmp: 0.02,
    threshold: 0.12,
    tintColor: '#ffffff',
    tintStrength: 0.0,
    waterTheme: 'blue',
    ritualTimeouts: [15, 15, 18, 18, 15],
};
const SFX_GAIN = 0.18;
const BGM_TRACKS = {
    waves: 'assets/audio/waves-bgm.mp3',
    deepsea: 'assets/audio/deepsea-bgm.mp3',
    fireworks: 'assets/audio/fireworks-bgm.mp3',
};
const BGM_VOLUME = 0.26;
const LANTERN_FLOCK = {
    separationWeight: 1.45,
    alignmentWeight: 0.42,
    cohesionWeight: 0.34,
    handAttractionWeight: 2.35,
    maxSpeed: 145,
    maxForce: 115,
    neighborRadius: 62,
    separationRadius: 27,
    arrivalRadius: 96,
};

// ═══════════════════════════════════════════════════════
// 阶段视觉基调表（水墨入卷 → 灯会之夜）
// 早段＝水墨写意：宣纸青灰、留白、暖金点睛；末段＝节庆灯会：暖金朱红
// 所有调色参数集中在这一张表里，?look=off 可整体旁路
// ═══════════════════════════════════════════════════════
const LOOK_ENABLED = new URLSearchParams(location.search).get('look') !== 'off';
const PHASE_LOOK = {
    water: {          // 水面引鱼 · 宣纸上的淡墨
        exposure: 1.02,
        fog:  { color: 0xaebfbe, density: 0.0009 },
        hemi: { sky: 0xe9f0ea, ground: 0x4f5a55, intensity: 1.35 },
        key:  { color: 0xffe2b0, intensity: 1.9 },
        rim:  { color: 0x9fd8d2, intensity: 1.1 },
        ripple: { inkStrength: 0.85, inkTint: 0x8da39d, accentWarm: 0xd9b25f, vignette: 0.34 },
        ambientColor: 0x6a7d88, bloom: null, bodyFx: 'ink',
    },
    fishing: {        // 钓鱼 · 墨色稍浓，鱼上岸时金光初现
        exposure: 1.05,
        fog:  { color: 0xa6bab9, density: 0.0011 },
        hemi: { sky: 0xe3ece6, ground: 0x46524e, intensity: 1.3 },
        key:  { color: 0xffd9a0, intensity: 2.2 },
        rim:  { color: 0x93cdc8, intensity: 1.15 },
        ripple: { inkStrength: 0.8, inkTint: 0x86988f, accentWarm: 0xd9b25f, vignette: 0.4 },
        ambientColor: 0x6a7d88, bloom: null, bodyFx: 'ink',
    },
    crafting: {       // 工艺 iframe 覆盖全屏，底层保持中性防切换闪色
        exposure: 1.0,
        fog:  { color: 0x0a0d10, density: 0.0010 },
        hemi: { sky: 0xd8ecff, ground: 0x2a1508, intensity: 1.4 },
        key:  { color: 0xffdf9a, intensity: 2.4 },
        rim:  { color: 0x82d9ff, intensity: 1.5 },
        ripple: { inkStrength: 0.5, inkTint: 0x6f7d7a, accentWarm: 0xd9b25f, vignette: 0.3 },
        ambientColor: 0x55606b, bloom: null, bodyFx: 'ink',
    },
    lanternReceive: { // 领灯 · 入夜，暖金初亮（亮度克制——纹理细节优先）
        exposure: 0.84,
        fog:  { color: 0x0b1826, density: 0.0008 },
        hemi: { sky: 0x35506e, ground: 0x46280f, intensity: 0.78 },
        key:  { color: 0xffc87a, intensity: 1.4 },
        rim:  { color: 0x6fa0cf, intensity: 0.95 },
        ripple: null, // 夜景阶段无 ripple pass
        ambientColor: 0x4488bb,
        sparkleWarmth: 0.65, bloom: { strength: 0.55, radius: 0.5, threshold: 0 }, // selective：只 BLOOM_LAYER 溢光
        bodyFx: 'festival',
    },
    lanternSwarm: {   // 群舞/放飞 · 灯会高潮，红金满目（亮在氛围，不亮在鱼身）
        exposure: 0.92,
        fog:  { color: 0x091522, density: 0.0007 },
        hemi: { sky: 0x3a5070, ground: 0x52300f, intensity: 0.85 },
        key:  { color: 0xffa257, intensity: 1.45 }, // 更橙：与背景灯笼同色温（鱼灯不再突兀发白金）
        rim:  { color: 0x7fb0e0, intensity: 0.8 },
        ripple: null,
        ambientColor: 0x4488bb,
        sparkleWarmth: 0.85, bloom: { strength: 0.75, radius: 0.55, threshold: 0 },
        bodyFx: 'festival',
    },
};

// 调色运行态：updatePhaseLook 每帧向 lookTarget 指数趋近（约 1.5s 收敛）
let sceneLights = null;           // init() 中收集 { hemi, key, rim }
let lookTargetKey = null;
let lookTarget = null;
let exposurePulse = 0;            // 放飞瞬间曝光脉冲（Step 7 触发）
let mainComposer = null;          // 夜景 bloom 管线（selective bloom 最终合成）
let bloomComposer = null;         // bloom 通道（只渲染 BLOOM_LAYER 物体，其余压黑保遮挡）
let mainBloomPass = null;
let mainBloomEnabled = false;
const BLOOM_LAYER = 11;           // 发光元素层：夜空火花/烟花/光晕/孔明灯/接触光斑；鱼灯本体不进
const _bloomDarkMesh = new THREE.MeshBasicMaterial({ color: 0x000000 });
const _bloomDarkPoints = new THREE.PointsMaterial({ color: 0x000000, size: 0.001 });
const _bloomDarkSprite = new THREE.SpriteMaterial({ color: 0x000000, opacity: 0 });
const _bloomDarkLine = new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0 });
const _bloomMatBackup = new Map();
function _darkenNonBloomed(obj) {
    if (!obj.material || obj.layers.isEnabled(BLOOM_LAYER)) return;
    let dark = null;
    if (obj.isSprite) dark = _bloomDarkSprite;
    else if (obj.isPoints) dark = _bloomDarkPoints;
    else if (obj.isLine) dark = _bloomDarkLine;
    else if (obj.isMesh) dark = _bloomDarkMesh;
    if (dark) {
        _bloomMatBackup.set(obj, obj.material);
        obj.material = dark;
    }
}
function _restoreBloomed(obj) {
    const mat = _bloomMatBackup.get(obj);
    if (mat) {
        obj.material = mat;
        _bloomMatBackup.delete(obj);
    }
}
const _lookTmp = new THREE.Color();
const lookState = {
    exposure: 1.0,
    fogColor: new THREE.Color(0x080810), fogDensity: 0.001,
    hemiSky: new THREE.Color(0xd8ecff), hemiGround: new THREE.Color(0x2a1508), hemiIntensity: 1.6,
    keyColor: new THREE.Color(0xffdf9a), keyIntensity: 2.8,
    rimColor: new THREE.Color(0x82d9ff), rimIntensity: 1.8,
    ambient: new THREE.Color(0x4488bb),
    inkStrength: 0, inkTint: new THREE.Color(0x8da39d),
    accentWarm: new THREE.Color(0xd9b25f), vignette: 0,
    sparkleWarmth: 0, bloomStrength: 0, boidsInk: 0,
};

// 共享径向光晕纹理（钓线金珠 / 接触光斑 / 鱼灯光晕），按颜色+尺寸缓存
const _glowTextureCache = new Map();
function createRadialGlowTexture(rgbaColor, size = 64) {
    const cacheKey = `${rgbaColor}@${size}`;
    if (_glowTextureCache.has(cacheKey)) return _glowTextureCache.get(cacheKey);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    const half = size / 2;
    const grad = ctx.createRadialGradient(half, half, 0, half, half, half);
    grad.addColorStop(0, rgbaColor);
    grad.addColorStop(0.35, rgbaColor.replace(/[\d.]+\)$/, '0.45)'));
    grad.addColorStop(1, rgbaColor.replace(/[\d.]+\)$/, '0)'));
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(canvas);
    _glowTextureCache.set(cacheKey, tex);
    return tex;
}

function applyPhaseLook(key) {
    if (!LOOK_ENABLED) return;
    const look = PHASE_LOOK[key];
    if (!look || lookTargetKey === key) return;
    lookTargetKey = key;
    lookTarget = look;
    document.body.classList.toggle('fx-ink', look.bodyFx === 'ink');
    document.body.classList.toggle('fx-festival', look.bodyFx === 'festival');
}

function updatePhaseLook(dt) {
    if (!LOOK_ENABLED || !lookTarget || !sceneLights) return;
    const t = lookTarget;
    const k = 1 - Math.exp(-dt * 1.8); // 指数趋近，约 1.5~2s 收敛
    lookState.exposure += (t.exposure - lookState.exposure) * k;
    lookState.fogColor.lerp(_lookTmp.set(t.fog.color), k);
    lookState.fogDensity += (t.fog.density - lookState.fogDensity) * k;
    lookState.hemiSky.lerp(_lookTmp.set(t.hemi.sky), k);
    lookState.hemiGround.lerp(_lookTmp.set(t.hemi.ground), k);
    lookState.hemiIntensity += (t.hemi.intensity - lookState.hemiIntensity) * k;
    lookState.keyColor.lerp(_lookTmp.set(t.key.color), k);
    lookState.keyIntensity += (t.key.intensity - lookState.keyIntensity) * k;
    lookState.rimColor.lerp(_lookTmp.set(t.rim.color), k);
    lookState.rimIntensity += (t.rim.intensity - lookState.rimIntensity) * k;
    lookState.ambient.lerp(_lookTmp.set(t.ambientColor), k);
    lookState.sparkleWarmth += ((t.sparkleWarmth ?? 0) - lookState.sparkleWarmth) * k;
    lookState.boidsInk += ((t.bodyFx === 'ink' ? 1 : 0) - lookState.boidsInk) * k;
    updateBoidsInkTint(lookState.boidsInk);

    // 应用到渲染器 / 场景 / 灯光
    exposurePulse = Math.max(0, exposurePulse * (1 - dt * 1.4));
    renderer.toneMappingExposure = lookState.exposure * (1 + exposurePulse * 0.22);
    if (scene.fog) {
        scene.fog.color.copy(lookState.fogColor);
        scene.fog.density = lookState.fogDensity;
    }
    sceneLights.hemi.color.copy(lookState.hemiSky);
    sceneLights.hemi.groundColor.copy(lookState.hemiGround);
    sceneLights.hemi.intensity = lookState.hemiIntensity;
    sceneLights.key.color.copy(lookState.keyColor);
    sceneLights.key.intensity = lookState.keyIntensity;
    sceneLights.rim.color.copy(lookState.rimColor);
    sceneLights.rim.intensity = lookState.rimIntensity;
    if (ambientBackgroundParticles) ambientBackgroundParticles.material.color.copy(lookState.ambient);

    // 水墨 ripple 调色（Step 2 提供 setInkGrade；目标为 null 时淡出水墨）
    if (waterRipple?.setInkGrade) {
        const ink = t.ripple;
        lookState.inkStrength += ((ink ? ink.inkStrength : 0) - lookState.inkStrength) * k;
        lookState.vignette += ((ink ? ink.vignette : 0) - lookState.vignette) * k;
        if (ink) {
            lookState.inkTint.lerp(_lookTmp.set(ink.inkTint), k);
            lookState.accentWarm.lerp(_lookTmp.set(ink.accentWarm), k);
        }
        waterRipple.setInkGrade(lookState.inkStrength, lookState.inkTint, lookState.accentWarm, lookState.vignette);
    }

    // 夜景 bloom（Step 7 创建 mainBloomPass 后生效）
    mainBloomEnabled = !!t.bloom;
    if (mainBloomPass) {
        const target = t.bloom ? t.bloom.strength : 0;
        lookState.bloomStrength += (target - lookState.bloomStrength) * k;
        mainBloomPass.strength = lookState.bloomStrength + exposurePulse * 0.25;
        if (t.bloom) {
            mainBloomPass.radius = t.bloom.radius;
            mainBloomPass.threshold = t.bloom.threshold;
        }
    }
}

/**
 * 制灯阶段嵌入 outputs-video。
 * 单服务器收敛：始终走同源 ./outputs-video/index.html（serve.py 从根目录提供），
 * 不再依赖独立的 4174 端口服务器（消除 B2/B4：跨端口白屏、start.ps1 写死路径）。
 * 仍支持 ?craftVideoUrl= 显式覆盖。
 */
function resolveCraftVideoUrl() {
    const params = new URLSearchParams(location.search);
    const override = params.get('craftVideoUrl');
    if (override) return override;
    // 若直接在 outputs-video 目录下打开（port 4174 旧布局），用本目录 index.html
    if (location.port === '4174') {
        return new URL('./index.html', location.href).href;
    }
    return new URL('./outputs-video/index.html?v=20260613-v6', location.href).href;
}

let craftVideoOpen = false;
let craftVideoUrl = null;
let pendingCraftVideoOpen = false;
let craftAwaitingClapReturn = false;
let lanternRevealActive = false;
let lanternRevealScatterTex = null;
let lanternSummonStage = 'idle'; // idle | waiting | particles | outlineHold | model
let lanternOutlineHoldTimer = null;
let lanternRevealOriginalPointSize = null;
let lanternModelFadeProgress = 1;
let lanternSummonSweep = { lastX: null, travel: 0, stableFrames: 0, lastAt: 0 };
let lanternReadyTimer = null;
let lanternDanceHintTimer = null;
let lanternDanceGroup = null;
let lanternDanceInstances = [];
let lanternDanceStartedAt = 0;
let lanternDanceReleaseProgress = 0;
let lanternDanceReleased = false;
let lanternDanceGesture = { sawFist: false, openFrames: 0 };
let lanternSwarmControl = {
    rawTarget: new THREE.Vector2(),
    target: new THREE.Vector2(),
    current: new THREE.Vector2(),
    velocity: new THREE.Vector2(),
    active: false,
    lastMoveAt: 0,
};
let lanternMergeReturnScheduled = false; // 汇群完成后自动回到水面（无人值守循环）
let lanternAutoReleaseTimer = null;      // 长时间未放飞则自动放飞（无人值守兜底）
let lanternParticleCompleteTimer = null;
const highDetailLanternCache = new Map();
const clapReturnGesture = { lastX: null, travel: 0, stable: 0 };
const okConfirmGesture = { frames: 0, cooldown: 0 };
let bgmAudio = null;
let bgmAutoStartBound = false;
let bgmUnlocked = false;
let bgmMode = 'waves';
let bgmSwitchToken = 0;

// 形态阶段（鱼影 → 鱼灯，中间过程暂时忽略）
const STAGES = [
    { name: '鱼影', key: 'fish' },
    { name: '鱼灯', key: 'lantern' },
];

// ═══════════════════════════════════════════════════════
// Shader 代码
// ═══════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════
// 2D 图像粒子网格 Shader（参考 CULTURAL HERITAGE 方案）
// GLB → 渲染为2D图像 → 图像驱动粒子网格
// ═══════════════════════════════════════════════════════
const vertexShader = /* glsl */`
    uniform float uTime;
    uniform float uSize;
    uniform float uMorph;         // 0~1 变形进度
    uniform float uBreathAmp;
    uniform float uFluidStrength; // 流动扰动
    uniform float uScatter;       // 手势散开力度 0~1
    uniform vec3 uHandWorld;
    uniform float uWind;          // 吹气风力 0~1
    uniform sampler2D uPosA;      // 形态A 位置纹理 (RGBA Float)
    uniform sampler2D uPosB;      // 形态B 位置纹理
    uniform sampler2D uColA;      // 形态A 颜色纹理
    uniform sampler2D uColB;      // 形态B 颜色纹理
    uniform vec3 uTintColor;
    uniform float uTintStrength;

    attribute vec2 aUv;           // 数据纹理采样坐标

    varying vec3 vColor;
    varying float vLuma;

    void main() {
        // 从数据纹理采样 3D 位置
        vec3 posA = texture2D(uPosA, aUv).xyz;
        vec3 posB = texture2D(uPosB, aUv).xyz;
        vec3 pos = mix(posA, posB, uMorph);

        // 从数据纹理采样颜色
        vec3 colA = texture2D(uColA, aUv).rgb;
        vec3 colB = texture2D(uColB, aUv).rgb;
        vColor = mix(colA, colB, uMorph);

        // 计算亮度
        vLuma = dot(vColor, vec3(0.299, 0.587, 0.114));

        // 染色叠加
        if (uTintStrength > 0.01) {
            vColor = mix(vColor, vColor * uTintColor, uTintStrength * 0.6);
        }

        // ═══ 游动动画 ═══
        // 用粒子在模型上的归一化 X 位置作为尾部因子
        float normX = (pos.x + 45.0) / 90.0; // 假设模型宽度约90
        float tailFactor = smoothstep(-0.2, 0.6, normX);
        
        // 身体 S 形传播波（从头到尾递增）
        float bodyWave = sin(normX * 8.0 - uTime * 4.0) * tailFactor * 3.5;
        pos.y += bodyWave;
        
        // 尾部额外大幅摆动
        float tailExtra = smoothstep(0.6, 1.0, normX);
        pos.y += sin(uTime * 5.0 - normX * 3.0) * tailExtra * 5.0;
        
        // 胸鳍区域微振（身体中部）
        float finArea = smoothstep(0.2, 0.4, normX) * smoothstep(0.6, 0.4, normX);
        float finWave = sin(uTime * 8.0) * finArea * 2.0;
        pos.z += finWave;
        
        // 整体上下浮动
        pos.y += sin(uTime * 1.0) * 2.0;
        // 轻微左右游动
        pos.x += sin(uTime * 0.7) * 1.2;

        // 呼吸动画（微弱缩放）
        float breath = 1.0 + sin(uTime * 2.0) * uBreathAmp;
        pos *= breath;

        // 流动扰动
        if (uFluidStrength > 0.01) {
            float noise = sin(pos.y * 0.08 + uTime * 1.5) * cos(pos.x * 0.08 + uTime);
            pos.x += noise * uFluidStrength * (1.0 - vLuma);
            pos.y += noise * uFluidStrength * 0.5;
        }

        // ═══ TD 风格形态转换特效 ═══
        // morphScatter: 0→1→0 (中间最大散开)
        float morphScatter = sin(uMorph * 3.14159);
        float morphScatter2 = morphScatter * morphScatter; // 更强的中间爆发
        float rnd = fract(sin(dot(aUv, vec2(12.9898, 78.233))) * 43758.5453);
        float rnd2 = fract(sin(dot(aUv * 2.3, vec2(53.1, 97.3))) * 2847.3);
        float rnd3 = fract(sin(dot(aUv * 7.1, vec2(21.7, 43.1))) * 6271.9);

        // 爆发飞散（粒子从原位置向外飞散，大幅度）
        vec3 flyDir = normalize(pos + vec3(rnd - 0.5, rnd2 - 0.5, rnd3 - 0.5) * 2.0);
        float flyDist = morphScatter2 * (25.0 + rnd * 55.0);
        pos += flyDir * flyDist;

        // 漩涡旋转（绕中心螺旋运动，TD标志性效果）
        float spiralAngle = uTime * 2.5 + rnd * 6.2832 + morphScatter * rnd2 * 8.0;
        float spiralRadius = morphScatter * (4.0 + rnd3 * 12.0);
        pos.x += cos(spiralAngle) * spiralRadius;
        pos.z += sin(spiralAngle) * spiralRadius;
        pos.y += sin(uTime * 1.8 + rnd * 6.2832) * morphScatter * 6.0;

        // curl noise 湍流（有机流动感）
        float noiseT = uTime * 1.2 + rnd * 8.0;
        pos.x += sin(pos.y * 0.06 + noiseT) * morphScatter * 8.0;
        pos.y += cos(pos.x * 0.06 + noiseT * 0.7) * morphScatter * 5.0;
        pos.z += sin(pos.z * 0.04 + noiseT * 0.5) * morphScatter * 4.0;

        // 手势散开
        if (uScatter > 0.01) {
            float d = length(pos);
            if (d > 0.1) {
                vec3 dir = normalize(pos);
                float rnd2 = fract(sin(dot(aUv * 3.7, vec2(53.1, 97.3))) * 2847.3);
                float push = uScatter * (35.0 + rnd2 * 25.0);
                pos += dir * push;
                pos.z += (rnd2 - 0.5) * uScatter * 30.0;
            }
        }

        // 吹气风力
        if (uWind > 0.01) {
            float windRnd = fract(sin(dot(aUv + uTime * 0.1, vec2(37.1, 81.7))) * 4375.5);
            pos.x += uWind * (20.0 + windRnd * 30.0);
            pos.y += uWind * (windRnd - 0.5) * 15.0;
            pos.z += uWind * (windRnd - 0.3) * 8.0;
        }

        vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
        // 变形时粒子放大3倍（更醒目的TD粒子效果）
        float morphSizeMul = 1.0 + morphScatter * 2.5;
        gl_PointSize = uSize * morphSizeMul * (300.0 / -mvPosition.z);
        gl_Position = projectionMatrix * mvPosition;
    }
`;

const fragmentShader = /* glsl */`
    uniform vec3 uTintColor;
    uniform float uTintStrength;
    uniform float uThreshold;
    uniform float uMorph;

    varying vec3 vColor;
    varying float vLuma;

    void main() {
        // 亮度过低（黑色/极暗）丢弃
        if (vLuma < 0.08) discard;
        // 亮度过高（接近白色/背景）降透明度
        float highLumaFade = 1.0 - smoothstep(uThreshold - 0.15, uThreshold, vLuma);

        // 圆形粒子遮罩
        vec2 coord = gl_PointCoord - vec2(0.5);
        float r2 = dot(coord, coord);
        if (r2 > 0.25) discard;

        // 边缘柔化（中心亮，边缘渐暗）
        float edgeFade = 1.0 - smoothstep(0.3, 0.5, sqrt(r2));

        vec3 rgb = vColor;

        // 色彩增强：提亮 + 饱和度提升
        rgb = pow(rgb, vec3(0.75)); // 反 gamma 提亮
        rgb *= 1.2; // 整体提亮

        // 金色高光增强
        vec3 gold = vec3(0.85, 0.65, 0.2);
        rgb = mix(rgb, gold, vLuma * 0.12);

        // 染色叠加
        if (uTintStrength > 0.01) {
            rgb = mix(rgb, rgb * uTintColor, uTintStrength * 0.6);
        }

        // TD 风格变形发光：转变中粒子发出温暖光芒（高亮度）
        float morphGlow = sin(uMorph * 3.14159);
        vec3 glowColor = mix(vec3(0.4, 0.7, 1.0), vec3(1.0, 0.8, 0.3), uMorph); // 蓝→金渐变
        rgb = mix(rgb, glowColor, morphGlow * 0.7); // 更强的颜色覆盖
        rgb += glowColor * morphGlow * 0.8; // 叠加发光
        // 变形期间大幅增加透明度（粒子更亮更实）
        float morphAlphaBoost = morphGlow * 0.6;

        // NormalBlending 高alpha，使粒子重叠形成实心表面
        float finalAlpha = edgeFade * 0.88 * highLumaFade + morphAlphaBoost;
        finalAlpha = clamp(finalAlpha, 0.0, 1.0);
        gl_FragColor = vec4(rgb, finalAlpha);
    }
`;

// ═══════════════════════════════════════════════════════
// 全局变量
// ═══════════════════════════════════════════════════════
let scene, camera, renderer, controls, particleSystem, uniforms;
let finalModel = null;
let finalModelMixer = null;
let isFinalModelVisible = false;
let boidsGroup;
let waterRipple;
let ambientBackgroundParticles;
let nightSparkles = null;
let fireworkBursts = [];
let nextFireworkAt = 0;
let clock = new THREE.Clock();
let currentStage = 0;
let isMorphing = false;
let morphProgress = 0;
let isBoidsMode = false;
let textures = [];

// 变形暗化遮罩
const morphOverlay = document.createElement('div');
morphOverlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);pointer-events:none;opacity:0;transition:opacity 0.5s;z-index:5;';
document.body.appendChild(morphOverlay);

// GLB 点云数据
let fishPointClouds = [];     // [{fish:{posTex,colTex}, lantern:{posTex,colTex}}, ...]
let currentFishIndex = 0;     // 当前鱼种索引

// 可嵌入粒子场景（鱼灯领取阶段激活，离开即释放显存）
let particleScene = null;
let particleSceneActive = false;
let pcTextures = { posA: null, posB: null, colA: null, colB: null };
// GLB 渲染为 2D 纹理（CRAFTING 阶段粒子系统用）
let fishRenderedTextures = { fish: null, lantern: null };
// GLB 网格模型（FISHING 阶段直接显示）
let fishMeshGroup = null;     // 当前显示的鱼网格 THREE.Group
let fishStippleMat = null;    // 粒子化材质引用
let fishMeshSwimTime = 0;     // 游动动画时间
let fishSwimCtrl = null;      // 当前目标鱼的游泳控制器
let fishSwimCtrls = [];       // 五条鱼各自的游泳控制器
let fishDartCtrl = null;      // 窜动行为控制器 FishDartController
let bgFishDartCtrls = [];     // 钓鱼阶段背景鱼游动
let fishSchool = null;        // 放生阶段鱼群 FishSchool
let fishingLine = null;       // 钓鱼线+鱼钩 Three.js 对象
let lanternMeshGroup = null;  // 鱼灯 GLB 模型
let allFishMeshes = [];       // 五种鱼型模板（各 1 个，用于克隆与放生阶段）
let waterFishInstances = [];  // 水中鱼影实例（同型多条，分散游动）
let targetFishInstance = null;  // 本次被钓中的那条实例
let bubbleSystem = null;      // 气泡特效
let splashSystem = null;      // 水花特效
let causticsEffect = null;    // 焦散光影
let handData = { detected: false, palmX: 0, palmY: 0, pinchDist: 1.0, isPinching: false, pinchCooldown: 0, fingersUp: 0 };
let sfxContext = null;
let sfxMaster = null;
// 旧版水平切换手势状态（保留占位，主流程已改为仪式手势）
let swipeState = { lastPalmX: 0, swipeAccum: 0, swipeCooldown: 0 };
// 张手/握拳散聚状态
let scatterStrength = 0; // 0=聚拢, 1=最大散开
let openPalmHoldTime = 0; // 张手保持时间（需>0.5s才触发散开）

// ── 制灯/放生 仪式手势状态机 ──────────────────────────────
// 每个手势有独立的积累计数器 + 冷却，防止误触
const RITUAL_COOLDOWN = 90; // 手势触发后冷却帧数（约1.5s@60fps）
let ritualCooldown = 0;     // 全局冷却（触发任意手势后锁定）

// ── Arduino 钓竿编码器交互 ───────────────────────────────
let fishingRodConnected = false;    // Arduino连接状态
let rodTension = 0;                 // 0-100 当前钓线张力百分比（编码器值）
let rodFishingState = 'idle';       // idle | biting | fighting | hooked
let rodFishingStartTime = 0;        // 钓鱼开始时间戳
let rodFishingSuccessWindow = [30, 70];// 张力需要在30-70%范围内保持3秒才能成功钓起
let rodLineLength = 100;            // 钓线长度（视觉反馈，0-100）
let rodTugStrength = 0;             // 鱼的挣扎强度（影响鱼的抖动幅度）
let rodTugTimer = 0;                // 鱼挣扎的时间计数
let rodHoldStart = 0;               // 张力保持在成功区间的开始时间
let rodLastTension = 0;             // 上一次编码器张力值，用于判断旋钮是否被转动
let rodRawValue = 0;                // 编码器原始有符号值，范围 -100..100
let rodTargetDirection = 0;         // 本轮钓鱼方向：0 未锁定，1 顺时针，-1 逆时针
let rodTargetValue = 0;             // 本轮随机目标值，带正负号
let rodTargetTolerance = 6;         // 目标值容差，避免旋钮太难停准
let rodZeroAdvanceReadyAt = 0;      // 卡片阶段允许“旋钮归零进入下一步”的时间
let rodZeroAdvanceDone = false;     // 防止归零触发重复进入下一步

// 手势1：双手向两侧推开 → 活鱼→骨架（stage 0→1）
// 检测：同时检测到两只手，且两手腕X距离持续扩大
let spreadGesture = { prevDist: 0, accumDelta: 0 };

// 手势2：单手从左到右缓慢抹过 → 骨架→糊纸（stage 1→2）
// 检测：手腕X从负到正持续移动，速度慢（仪式感）
let wipeGesture = { startX: null, traveling: false, accumX: 0 };

// 手势3：握拳→张开 → 糊纸→上色（stage 2→3）
// 检测：fingersUp从≤1升到≥4
let bloomGesture = { wasFist: false, holdFistTime: 0 };

// 合掌返回：双手从开到合（工艺页完成后）
// 手势4：双手靠近→向上托起 → 上色→鱼灯（stage 3→4）
// 检测：两手腕距离接近（<0.28）且双手整体上移
let liftGesture = { wasClose: false, closeTime: 0, startY: null, riseAccum: 0 };

// 放生手势：张开五指向前推→手腕持续上移 → 放生完成
// 检测：fingersUp=5 保持 + palmY持续减小（上移）
let releaseGesture = { openTime: 0, startY: null, riseAccum: 0 };

function getSfxContext() {
    if (!sfxContext) sfxContext = new (window.AudioContext || window.webkitAudioContext)();
    if (!sfxMaster) {
        sfxMaster = sfxContext.createGain();
        sfxMaster.gain.value = 0.35;
        sfxMaster.connect(sfxContext.destination);
    }
    if (sfxContext.state === 'suspended') sfxContext.resume();
    return sfxContext;
}

let sfxMuted = false; // HUD 静音开关
function getBgmAudio() {
    if (!bgmAudio) {
        bgmAudio = document.getElementById('bgm-track');
        if (bgmAudio) {
            bgmAudio.loop = true;
            bgmAudio.preload = 'auto';
            bgmAudio.volume = BGM_VOLUME;
        }
    }
    return bgmAudio;
}

async function ensureBgmPlaying() {
    const audio = getBgmAudio();
    if (!audio || sfxMuted) return false;
    try {
        audio.volume = BGM_VOLUME;
        audio.muted = false;
        if (audio.paused) await audio.play();
        bgmUnlocked = true;
        updateBgmButtonState();
        return true;
    } catch (err) {
        // Browser autoplay policy may still require a user gesture.
        return false;
    }
}

function syncBgmMuteState() {
    const audio = getBgmAudio();
    if (!audio) return;
    audio.muted = sfxMuted;
    if (sfxMuted) {
        audio.pause();
    } else {
        ensureBgmPlaying();
    }
    updateBgmButtonState();
}

function updateBgmButtonState() {
    const btn = document.getElementById('hud-mute');
    if (!btn) return;
    btn.textContent = sfxMuted ? '🔇' : '🔊';
    btn.classList.toggle('muted', sfxMuted);
    btn.setAttribute('aria-pressed', String(sfxMuted));
}

async function setBgmTrack(mode, { restart = true } = {}) {
    const src = BGM_TRACKS[mode];
    const audio = getBgmAudio();
    if (!src || !audio) return false;
    bgmMode = mode;
    if (sfxMuted) {
        audio.pause();
        updateBgmButtonState();
        return false;
    }

    const token = ++bgmSwitchToken;
    const nextUrl = new URL(src, location.href).href;
    const currentUrl = audio.currentSrc || audio.src || '';
    const srcChanged = currentUrl !== nextUrl;
    try {
        if (srcChanged) {
            audio.pause();
            audio.src = src;
            audio.load();
        }
        if (restart) audio.currentTime = 0;
        audio.volume = BGM_VOLUME;
        audio.muted = false;
        await audio.play();
        if (token !== bgmSwitchToken) return false;
        bgmUnlocked = true;
        updateBgmButtonState();
        return true;
    } catch (err) {
        // Retry from the next user gesture or explicit phase transition.
        return false;
    }
}

function bindBgmAutoStart() {
    if (bgmAutoStartBound) return;
    bgmAutoStartBound = true;
    const events = ['pointerdown', 'pointerup', 'click', 'keydown', 'touchstart'];
    const kick = async () => {
        if (!sfxMuted) {
            const played = await setBgmTrack(bgmMode || 'waves', { restart: false });
            if (played) {
                events.forEach((eventName) => {
                    document.removeEventListener(eventName, kick, true);
                });
            }
        }
    };
    events.forEach((eventName) => {
        document.addEventListener(eventName, kick, { capture: true, passive: true });
    });
}

function playTone({
    freqs,
    type = 'sine',
    duration = 0.4,
    attack = 0.01,
    decay = 0.18,
    sustain = 0.2,
    release = 0.3,
    gain = 0.18,
    filterHz = null,
    noise = 0.0,
    detune = 0
} = {}) {
    if (sfxMuted) return;
    try {
        const ctx = getSfxContext();
        const now = ctx.currentTime;
        const env = ctx.createGain();
        const targetGain = SFX_GAIN;
        env.gain.setValueAtTime(0.0001, now);
        env.gain.linearRampToValueAtTime(targetGain, now + attack);
        env.gain.linearRampToValueAtTime(targetGain * sustain, now + attack + decay);
        env.gain.exponentialRampToValueAtTime(0.0001, now + duration + release);

        let out = env;
        if (filterHz) {
            const lp = ctx.createBiquadFilter();
            lp.type = 'lowpass';
            lp.frequency.value = filterHz;
            env.connect(lp);
            out = lp;
        }
        out.connect(sfxMaster);

        const frequencyList = Array.isArray(freqs) ? freqs : [freqs];
        frequencyList.forEach((f) => {
            const osc = ctx.createOscillator();
            osc.type = type;
            osc.frequency.value = f;
            osc.detune.value = detune;
            osc.connect(env);
            osc.start(now);
            osc.stop(now + duration + release + 0.05);
        });

        if (noise > 0) {
            const buffer = ctx.createBuffer(1, ctx.sampleRate * (duration + release), ctx.sampleRate);
            const data = buffer.getChannelData(0);
            for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * noise;
            const src = ctx.createBufferSource();
            src.buffer = buffer;
            src.connect(env);
            src.start(now);
            src.stop(now + duration + release + 0.05);
        }
    } catch (e) {
        // Audio not available or blocked; ignore.
    }
}

function playPhaseSfx(phase) {
    switch (phase) {
        case PHASES.WATER:
            // Water droplet + soft shimmer
            playTone({ freqs: [660, 990], type: 'sine', duration: 0.18, attack: 0.005, decay: 0.06, sustain: 0.2, release: 0.12, gain: 0.14, filterHz: 1400, noise: 0.08 });
            break;
        case PHASES.FISHING:
            // Bamboo chime
            playTone({ freqs: [523.25, 783.99], type: 'triangle', duration: 0.35, attack: 0.01, decay: 0.12, sustain: 0.25, release: 0.25, gain: 0.2, filterHz: 1800 });
            break;
        case PHASES.CRAFTING:
            // Guqin pluck
            playTone({ freqs: 392.0, type: 'triangle', duration: 0.45, attack: 0.008, decay: 0.14, sustain: 0.2, release: 0.35, gain: 0.22, filterHz: 1200 });
            break;
        case PHASES.LANTERN_SWARM:
            // Bell-like release
            playTone({ freqs: [659.25, 1318.5], type: 'sine', duration: 0.6, attack: 0.01, decay: 0.2, sustain: 0.2, release: 0.6, gain: 0.25, filterHz: 2200 });
            break;
        default:
            break;
    }
}

function playRitualSfx(stage) {
    switch (stage) {
        case 1:
            // Spread frame: woody knock
            playTone({ freqs: 220.0, type: 'triangle', duration: 0.22, attack: 0.005, decay: 0.08, sustain: 0.2, release: 0.18, gain: 0.2, filterHz: 900, noise: 0.04 });
            break;
        case 2:
            // Wipe: brush swish
            playTone({ freqs: 330.0, type: 'sine', duration: 0.25, attack: 0.01, decay: 0.08, sustain: 0.1, release: 0.18, gain: 0.12, filterHz: 1400, noise: 0.22 });
            break;
        case 3:
            // Bloom: ink shimmer
            playTone({ freqs: [523.25, 659.25], type: 'sine', duration: 0.3, attack: 0.01, decay: 0.1, sustain: 0.2, release: 0.25, gain: 0.18, filterHz: 2000 });
            break;
        case 4:
            // Lift: lantern ignition
            playTone({ freqs: [440.0, 880.0], type: 'triangle', duration: 0.4, attack: 0.01, decay: 0.12, sustain: 0.2, release: 0.35, gain: 0.22, filterHz: 1700 });
            break;
        case 'release':
            // Release: airy drift
            playTone({ freqs: 330.0, type: 'sine', duration: 0.45, attack: 0.02, decay: 0.12, sustain: 0.2, release: 0.35, gain: 0.16, filterHz: 1800, noise: 0.18 });
            break;
        default:
            break;
    }
}

// 手势提示文字映射
const GESTURE_HINTS = {
    0: '双手张开向两侧推 · 制作鱼灯',
    1: '鱼灯完成 · 张手向上放生',
};
const RITUAL_CUES = {
    water: {
        gesture: 'release',
        kicker: '入场',
        title: '挥掌唤醒鱼影',
        subtitle: '张开手掌左右轻摆，沿着水面制造涟漪。',
    },
    fishing: {
        gesture: 'wipe',
        kicker: '钓鱼',
        title: '第一次捏合，放下鱼线',
        subtitle: '用拇指与食指捏合，放下鱼线。松开手指后，再次捏合即可提线。',
    },
    0: {
        gesture: 'spread',
        kicker: '制灯 · 非遗工艺',
        title: '双手向两侧推开',
        subtitle: '进入数字工艺场域，体验画模、扎架、扪纱、点睛四序粒子鱼灯。',
    },
    1: {
        gesture: 'release',
        kicker: '完成',
        title: '张开手掌向上抬',
        subtitle: '把鱼灯送回水面，完成放生。',
    },
    catch: {
        gesture: 'spread',
        kicker: '鱼影上岸',
        title: '阅读右侧知识卡片',
        subtitle: '点击「进入工艺体验」或双手推开，开始制灯。',
    },
    reveal: {
        gesture: 'bloom',
        kicker: '鱼影显形',
        title: '张手化光 · 握拳凝形',
        subtitle: '张开手掌让鱼影化作光点，握拳重新凝聚。光点完全散尽，或点击「开始制灯」，进入制灯。',
    },
};
// 麦克风/吹气检测
let micAnalyser = null;
let micDataArray = null;
let blowStrength = 0; // 0~1 吹气强度

// 页面阶段状态机
const PHASES = {
    WATER: 'water',       // 水面阶段：只有水波纹
    FISHING: 'fishing',   // 钓鱼阶段：鱼跃出水面
    CRAFTING: 'crafting', // 制灯阶段：形态切换
    LANTERN_RECEIVE: 'lanternReceive', // 鱼灯领取：单盏专属鱼灯
    LANTERN_SWARM: 'lanternSwarm',     // 鱼灯游群：十盏鱼灯巡游
};
let currentPhase = PHASES.WATER;
let phaseTransitioning = false;
let RITUAL_TIMEOUTS = [...DEFAULTS.ritualTimeouts];
let ritualTimeoutTimer = 0;
let ambientRippleTimer = 0;
let loaderReady = false;

function setLoaderProgress(pct, text) {
    const bar = document.getElementById('loader-progress');
    const sub = document.querySelector('.loader-sub');
    if (bar) bar.style.width = `${Math.min(100, Math.max(0, pct))}%`;
    if (sub && text) sub.textContent = text;
}

function hideLoader() {
    if (loaderReady) return;
    loaderReady = true;
    setLoaderProgress(100, '准备就绪');
    const loader = document.getElementById('loader');
    if (!loader) return;
    loader.classList.add('hidden');
    setTimeout(() => loader.remove(), 900);
}

function resetRitualTimeout() {
    ritualTimeoutTimer = 0;
}

// ═══════════════════════════════════════════════════════
// 初始化
// ═══════════════════════════════════════════════════════
async function init() {
    // 场景
    scene = new THREE.Scene();
    // 不设置 scene.background - 让水波纹背景透出来
    scene.fog = new THREE.FogExp2(0x080810, 0.001);
    const hemiLight = new THREE.HemisphereLight(0xd8ecff, 0x2a1508, 1.6);
    scene.add(hemiLight);
    const finalKeyLight = new THREE.DirectionalLight(0xffdf9a, 2.8);
    finalKeyLight.position.set(120, 150, 120);
    scene.add(finalKeyLight);
    const finalRimLight = new THREE.DirectionalLight(0x82d9ff, 1.8);
    finalRimLight.position.set(-140, 80, -120);
    scene.add(finalRimLight);
    sceneLights = { hemi: hemiLight, key: finalKeyLight, rim: finalRimLight }; // PHASE_LOOK 调色引用

    // 相机
    camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(0, 0, CONFIG.cameraZ);

    // 渲染器
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setClearColor(0x000000, 0); // 透明背景
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    if (LOOK_ENABLED) {
        // 电影感滚降：只影响 GLB 内置材质（自定义 ShaderMaterial 不受 renderer tone mapping 影响）
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.02;
        // IBL 环境光照：让 GLB 的 PBR 材质（纱绸/漆面/鳞片）有真实光泽反射，
        // 不换模型情况下对观感提升最大的一项
        const pmrem = new THREE.PMREMGenerator(renderer);
        scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
        scene.environmentIntensity = 0.2; // 收着用：保留三灯的舞台感，环境光只补质感（过高会把金色鱼灯推过曝）
        pmrem.dispose();

        // 夜景灯会 selective bloom：bloom 通道只见 BLOOM_LAYER（火花/烟花/光晕/孔明灯），
        // 鱼灯本体压黑保遮挡、完全不溢光 → 主体锐利，光只从该发光的地方溢出
        bloomComposer = new EffectComposer(renderer);
        bloomComposer.renderToScreen = false;
        bloomComposer.addPass(new RenderPass(scene, camera));
        mainBloomPass = new UnrealBloomPass(
            new THREE.Vector2(window.innerWidth, window.innerHeight), 0.0, 0.5, 0.0);
        bloomComposer.addPass(mainBloomPass);

        const mixPass = new ShaderPass(new THREE.ShaderMaterial({
            uniforms: {
                baseTexture: { value: null },
                bloomTexture: { value: bloomComposer.renderTarget2.texture },
            },
            vertexShader: /* glsl */`
                varying vec2 vUv;
                void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
            fragmentShader: /* glsl */`
                uniform sampler2D baseTexture;
                uniform sampler2D bloomTexture;
                varying vec2 vUv;
                void main() {
                    vec4 base = texture2D(baseTexture, vUv);
                    gl_FragColor = vec4(base.rgb + texture2D(bloomTexture, vUv).rgb, base.a);
                }`,
        }), 'baseTexture');
        mixPass.needsSwap = true;

        mainComposer = new EffectComposer(renderer);
        mainComposer.addPass(new RenderPass(scene, camera));
        mainComposer.addPass(mixPass);
        mainComposer.addPass(new OutputPass());
    }
    document.getElementById('canvas-container').appendChild(renderer.domElement);

    // 水下特效系统
    bubbleSystem = new BubbleSystem(scene);
    splashSystem = new SplashSystem(scene);
    causticsEffect = new CausticsEffect(scene, { width: 350, height: 220, z: -8 });

    // 轨道控制（鼠标兜底操作）
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.3;
    controls.enablePan = false;
    controls.minDistance = 50;
    controls.maxDistance = 300;

    // 加载纹理
    await loadTextures();

    // 创建粒子系统
    createParticleSystem();

    // 创建鱼群（隐藏状态）
    createBoids();

    // 加载终局 3D 鱼模型（隐藏状态）
    loadFinalModel();

    // 添加水波纹背景粒子
    createBackgroundParticles();
    setLoaderProgress(98, '正在启动交互系统...');

    // 设置 UI 交互
    setupUI();

    // 设置手势识别
    setupMediaPipe();

    // 设置手机连接（PeerJS + QR码）
    setupPeerConnection();

    // 监听窗口
    window.addEventListener('resize', onResize);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('message', (event) => {
        if (event.origin !== location.origin) return;
        const { type } = event.data || {};
        if (type === 'craft-experience-complete') finishCraftVideoAndRevealLantern();
        if (type === 'craft-clap-exit') finishCraftVideoAndRevealLantern();
    });

    hideLoader();

    // 初始化阶段：从水面开始（加载完成后才显示引导）
    enterPhase(PHASES.WATER);

    // 渲染循环
    animate();
}

// ═══════════════════════════════════════════════════════
// 纹理加载
// ═══════════════════════════════════════════════════════
async function loadTextures() {
    setLoaderProgress(5, '正在初始化场景...');
    const loaderSub = document.querySelector('.loader-sub');
    fishPointClouds = await loadAllFishPointClouds(CONFIG.texSize, 90, (loaded, total) => {
        console.log(`[INFO] 点云采样: ${FISH_TYPES[loaded - 1].name} (${loaded}/${total})`);
        const pct = 5 + (loaded / total) * 55;
        setLoaderProgress(pct, `正在采样点云... ${loaded}/${total}`);
        if (loaderSub) loaderSub.textContent = `正在采样点云... ${loaded}/${total}`;
    });
    applyFishTextures(currentFishIndex, 0);
    console.log(`[INFO] 全部点云加载完成, ${FISH_TYPES.length} 种鱼, 每种 ${CONFIG.texSize * CONFIG.texSize} 粒子`);

    setLoaderProgress(65, '正在加载 8 条鱼影…');
    if (loaderSub) loaderSub.textContent = '正在加载 8 条鱼影…';
    await loadAllFishMeshes();
    setActiveFishMesh(0);
    await loadLanternMesh(currentFishIndex);

    setLoaderProgress(92, '正在准备水面特效...');
}

async function loadAllFishMeshes() {
    allFishMeshes = [];
    fishSwimCtrls = [];
    const NOSE_FLIPPED = [0, 3];
    const flipMatrix = new THREE.Matrix4().makeRotationY(Math.PI);
    for (let i = 0; i < FISH_TYPES.length; i++) {
        try {
            const mesh = await loadGLBMesh(FISH_TYPES[i].fish, 90);
            mesh.visible = false;
            if (NOSE_FLIPPED.includes(i)) {
                mesh.traverse((child) => {
                    if (child.isMesh && child.geometry) child.geometry.applyMatrix4(flipMatrix);
                });
            }
            scene.add(mesh);
            // 方案 A：运行时绑骨——真骨骼链游动；虾=弹尾脉冲，蟹=横行摇摆
            const swimStyle = FISH_TYPES[i].name.includes('虾') ? 'shrimp'
                : (FISH_TYPES[i].name.includes('蟹') ? 'crab' : 'fish');
            fishSwimCtrls.push(buildSpineRig(mesh, {
                speed: 3.5, amplitude: 0.08, frequency: 1.4, tailBias: 2.2, style: swimStyle,
            }));
            allFishMeshes.push(mesh);
        } catch (e) {
            console.warn(`[WARN] 鱼影模型 ${FISH_TYPES[i].name} 加载失败`, e);
        }
    }
    console.log(`[INFO] 五种鱼型模板加载完成: ${allFishMeshes.length} 种`);
    spawnWaterFishInstances();
}

function spawnWaterFishInstances() {
    waterFishInstances.forEach((inst) => scene.remove(inst.mesh));
    waterFishInstances = [];
    targetFishInstance = null;

    FISH_INSTANCE_LAYOUT.forEach((layout) => {
        const template = allFishMeshes[layout.typeIndex];
        if (!template) return;
        // SkeletonUtils.clone 正确复制骨架与蒙皮绑定；attachSpineRig 只挂驱动器不重做蒙皮
        const mesh = SkeletonUtils.clone(template);
        mesh.visible = false;
        scene.add(mesh);
        waterFishInstances.push({
            mesh,
            typeIndex: layout.typeIndex,
            swimCtrl: attachSpineRig(mesh, {
                speed: 3.6 + (layout.typeIndex % 3) * 0.4,
                amplitude: 0.16 + (layout.scaleMul - 0.13) * 0.5,
                style: FISH_TYPES[layout.typeIndex].name.includes('虾') ? 'shrimp'
                    : (FISH_TYPES[layout.typeIndex].name.includes('蟹') ? 'crab' : 'fish'),
                frequency: 1.4,
                tailBias: 2.2,
            }),
            layout,
            isTarget: false,
        });
    });
    console.log(`[INFO] 水中鱼影实例: ${waterFishInstances.length} 条`);
}

function setActiveFishMesh(fishIdx) {
    if (!allFishMeshes[fishIdx]) return;
    currentFishIndex = fishIdx;
    if (targetFishInstance && targetFishInstance.typeIndex === fishIdx) {
        fishMeshGroup = targetFishInstance.mesh;
        fishSwimCtrl = targetFishInstance.swimCtrl;
    } else {
        fishMeshGroup = allFishMeshes[fishIdx];
        fishSwimCtrl = fishSwimCtrls[fishIdx];
    }
}

/**
 * 加载鱼灯 GLB 模型
 */
async function loadLanternMesh(fishIdx) {
    const fishType = FISH_TYPES[fishIdx];
    if (!fishType) return;
    if (lanternMeshGroup) {
        scene.remove(lanternMeshGroup);
        lanternMeshGroup = null;
    }
    try {
        lanternMeshGroup = cloneLanternForDance(await loadHighDetailLanternTemplate(fishIdx));
        lanternMeshGroup.userData._lanternBaseScale = lanternMeshGroup.scale.clone();
        lanternMeshGroup.visible = false;
        scene.add(lanternMeshGroup);
        console.log(`[INFO] 鱼灯模型加载完成: ${fishType.name}`);
    } catch (err) {
        console.warn('[WARN] 鱼灯模型加载失败:', err);
    }
}

/**
 * 应用指定鱼种的点云纹理到 uniforms
 * @param {number} fishIdx - 鱼种索引
 * @param {number} stageIdx - 0=鱼影, 1=鱼灯
 */
function applyFishTextures(fishIdx, stageIdx) {
    const data = fishPointClouds[fishIdx];
    if (!data) return;
    const stageKey = stageIdx === 0 ? 'fish' : 'lantern';
    pcTextures.posA = data[stageKey].posTex;
    pcTextures.posB = data[stageKey].posTex;
    pcTextures.colA = data[stageKey].colTex;
    pcTextures.colB = data[stageKey].colTex;
    if (uniforms) {
        uniforms.uPosA.value = pcTextures.posA;
        uniforms.uPosB.value = pcTextures.posB;
        uniforms.uColA.value = pcTextures.colA;
        uniforms.uColB.value = pcTextures.colB;
        uniforms.uMorph.value = 0.0;
    }
}

/**
 * 切换鱼种（保持当前阶段）
 */
async function switchFishType(newIndex) {
    if (isMorphing) return;
    if (newIndex < 0) newIndex = FISH_TYPES.length - 1;
    if (newIndex >= FISH_TYPES.length) newIndex = 0;
    currentFishIndex = newIndex;
    applyFishTextures(currentFishIndex, currentStage);
    
    // 同时更新网格模型
    setActiveFishMesh(newIndex);
    await loadLanternMesh(currentFishIndex);
    
    console.log(`[INFO] 切换鱼种: ${FISH_TYPES[currentFishIndex].name}`);
    // Toast提示
    showToast(`🐟 ${FISH_TYPES[currentFishIndex].name}`);
    // 更新 UI 提示
    const hintEl = document.getElementById('hint-text');
    if (hintEl && currentPhase === PHASES.CRAFTING) {
        hintEl.textContent = `${FISH_TYPES[currentFishIndex].name} · ${STAGES[currentStage].name}`;
    }
}

// ═══════════════════════════════════════════════════════
// 粒子系统（3D 点云 + 数据纹理驱动）
// ═══════════════════════════════════════════════════════
function createParticleSystem() {
    const count = CONFIG.texSize;
    const numParticles = count * count;

    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(numParticles * 3); // 占位（实际位置由shader从纹理读取）
    const uvs = new Float32Array(numParticles * 2);

    // 生成索引 UV（用于在 shader 中查找数据纹理）
    let idx = 0;
    for (let y = 0; y < count; y++) {
        for (let x = 0; x < count; x++) {
            const u = (x + 0.5) / count;
            const v = (y + 0.5) / count;

            positions[idx * 3]     = 0;
            positions[idx * 3 + 1] = 0;
            positions[idx * 3 + 2] = 0;

            uvs[idx * 2]     = u;
            uvs[idx * 2 + 1] = v;

            idx++;
        }
    }

    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aUv', new THREE.BufferAttribute(uvs, 2));

    // 创建占位纹理（1×1 黑色 Float）
    const placeholderTex = new THREE.DataTexture(
        new Float32Array([0, 0, 0, 1]), 1, 1, THREE.RGBAFormat, THREE.FloatType
    );
    placeholderTex.needsUpdate = true;

    uniforms = {
        uTime:          { value: 0 },
        uPosA:          { value: pcTextures.posA || placeholderTex },
        uPosB:          { value: pcTextures.posB || placeholderTex },
        uColA:          { value: pcTextures.colA || placeholderTex },
        uColB:          { value: pcTextures.colB || placeholderTex },
        uMorph:         { value: 0.0 },
        uSize:          { value: CONFIG.pointSize },
        uBreathAmp:     { value: 0.02 },
        uFluidStrength: { value: 0.0 },
        uScatter:       { value: 0.0 },
        uHandWorld:     { value: new THREE.Vector3(0, 0, 0) },
        uWind:          { value: 0.0 },
        uTintColor:     { value: new THREE.Vector3(1, 1, 1) },
        uTintStrength:  { value: 0.0 },
        uThreshold:     { value: 0.85 },
    };

    const material = new THREE.ShaderMaterial({
        uniforms,
        vertexShader,
        fragmentShader,
        transparent: true,
        depthWrite: true,
        blending: THREE.NormalBlending,
    });

    particleSystem = new THREE.Points(geometry, material);
    particleSystem.frustumCulled = false;
    scene.add(particleSystem);
    // DEBUG
    window.__uniforms = uniforms;
    window.__pcTextures = pcTextures;
    window.__scene = scene;
    window.__particleSystem = particleSystem;
}

// ═══════════════════════════════════════════════════════
// 鱼群 Boids（InstancedMesh 方向感鱼形粒子）
// ═══════════════════════════════════════════════════════
let boidsPositions, boidsVelocities;
let boidsInstancedMesh;
const BOIDS_DUMMY = new THREE.Object3D();

function createBoids() {
    boidsGroup = new THREE.Group();
    boidsGroup.visible = false;
    scene.add(boidsGroup);

    const count = CONFIG.boidsCount;
    boidsPositions = new Float32Array(count * 3);
    boidsVelocities = [];

    for (let i = 0; i < count; i++) {
        boidsPositions[i * 3]     = (Math.random() - 0.5) * 200;
        boidsPositions[i * 3 + 1] = (Math.random() - 0.5) * 150;
        boidsPositions[i * 3 + 2] = (Math.random() - 0.5) * 60;

        boidsVelocities.push(new THREE.Vector3(
            (Math.random() - 0.5) * 0.8,
            (Math.random() - 0.5) * 0.8,
            (Math.random() - 0.5) * 0.4
        ));
    }

    // 鱼形几何：拉长的菱形 + 分叉尾
    const fishShape = new THREE.BufferGeometry();
    const verts = new Float32Array([
        // 身体（菱形）
        -1.2, 0, 0,    // 头
         0.0, 0.35, 0,  // 上
         0.8, 0, 0,     // 尾根
         0.0, -0.35, 0, // 下
        // 尾巴 (V形)
         0.8, 0, 0,     // 尾根
         1.5, 0.4, 0,   // 尾上
         1.2, 0, 0,     // 尾中
         1.5, -0.4, 0,  // 尾下
    ]);
    const indices = [
        0, 1, 2,  0, 2, 3,  // 身体
        4, 5, 6,  4, 6, 7,  // 尾巴
    ];
    fishShape.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    fishShape.setIndex(indices);
    fishShape.computeVertexNormals();

    // InstancedMesh 材质：半透明鱼形
    const fishMat = new THREE.MeshBasicMaterial({
        color: 0xcc8833,
        transparent: true,
        opacity: 0.7,
        side: THREE.DoubleSide,
        blending: THREE.NormalBlending,
        depthWrite: false,
    });

    boidsInstancedMesh = new THREE.InstancedMesh(fishShape, fishMat, count);
    boidsInstancedMesh.frustumCulled = false;

    // 初始化实例颜色（暖金到朱红渐变）；水墨段整体降饱和偏墨色，
    // 但留 ~15% 的「点睛之鱼」保持暖金（画面唯一暖色焦点）
    const color = new THREE.Color();
    const warmColors = new Float32Array(count * 3);
    const accentFlags = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
        const hue = 0.02 + Math.random() * 0.08;
        const sat = 0.75 + Math.random() * 0.25;
        const lum = 0.45 + Math.random() * 0.25;
        color.setHSL(hue, sat, lum);
        warmColors[i * 3] = color.r;
        warmColors[i * 3 + 1] = color.g;
        warmColors[i * 3 + 2] = color.b;
        accentFlags[i] = Math.random() < 0.15 ? 1 : 0;
        boidsInstancedMesh.setColorAt(i, color);
    }
    boidsInstancedMesh.instanceColor.needsUpdate = true;
    boidsInstancedMesh.userData._warmColors = warmColors;
    boidsInstancedMesh.userData._accentFlags = accentFlags;
    boidsInstancedMesh.userData._inkAmount = -1; // 强制首次刷新

    boidsGroup.add(boidsInstancedMesh);
}

// 鱼群水墨化：warm 基色 → 青灰墨色（点睛之鱼保留暖金）
const _boidInkColor = new THREE.Color(0x55626a);
const _boidTmpColor = new THREE.Color();
function updateBoidsInkTint(inkAmount) {
    if (!boidsInstancedMesh) return;
    const prev = boidsInstancedMesh.userData._inkAmount;
    if (Math.abs(inkAmount - prev) < 0.01) return;
    boidsInstancedMesh.userData._inkAmount = inkAmount;
    const warm = boidsInstancedMesh.userData._warmColors;
    const accent = boidsInstancedMesh.userData._accentFlags;
    const count = CONFIG.boidsCount;
    for (let i = 0; i < count; i++) {
        _boidTmpColor.setRGB(warm[i * 3], warm[i * 3 + 1], warm[i * 3 + 2]);
        if (!accent[i]) _boidTmpColor.lerp(_boidInkColor, inkAmount * 0.8);
        boidsInstancedMesh.setColorAt(i, _boidTmpColor);
    }
    boidsInstancedMesh.instanceColor.needsUpdate = true;
}

function updateBoids(target, mode = 'follow') {
    if (!boidsGroup.visible || !boidsPositions || !boidsInstancedMesh) return;

    const count = CONFIG.boidsCount;
    const maxSpeed = mode === 'attract' ? 2.5 : 1.8;
    const maxForce = 0.04;
    const perceptionR = 35;

    for (let i = 0; i < count; i++) {
        const px = boidsPositions[i * 3];
        const py = boidsPositions[i * 3 + 1];
        const pz = boidsPositions[i * 3 + 2];
        const vel = boidsVelocities[i];

        let sepX = 0, sepY = 0, sepZ = 0;
        let aliX = 0, aliY = 0, aliZ = 0;
        let cohX = 0, cohY = 0, cohZ = 0;
        let total = 0;

        for (let j = 0; j < count; j += 3) {
            if (i === j) continue;
            const dx = px - boidsPositions[j * 3];
            const dy = py - boidsPositions[j * 3 + 1];
            const dz = pz - boidsPositions[j * 3 + 2];
            const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (dist > 0 && dist < perceptionR) {
                sepX += dx / dist; sepY += dy / dist; sepZ += dz / dist;
                aliX += boidsVelocities[j].x; aliY += boidsVelocities[j].y; aliZ += boidsVelocities[j].z;
                cohX += boidsPositions[j * 3]; cohY += boidsPositions[j * 3 + 1]; cohZ += boidsPositions[j * 3 + 2];
                total++;
            }
        }

        let ax = 0, ay = 0, az = 0;

        if (mode === 'scatter') {
            // 张手散开：从手掌位置推开
            const dx = px - target.x, dy = py - target.y, dz = pz - target.z;
            const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) + 0.1;
            const repel = 8.0 / (dist * 0.1 + 1.0);
            ax += (dx / dist) * repel * 0.01;
            ay += (dy / dist) * repel * 0.01;
            az += (dz / dist) * repel * 0.005;
            // 保留弱分离力
            if (total > 0) {
                sepX /= total; sepY /= total; sepZ /= total;
                ax += sepX * maxForce * 2.0; ay += sepY * maxForce * 2.0; az += sepZ * maxForce * 2.0;
            }
        } else {
            // follow / attract 模式使用正常 boids 规则
            if (total > 0) {
                sepX /= total; sepY /= total; sepZ /= total;
                ax += sepX * maxForce * 3.5; ay += sepY * maxForce * 3.5; az += sepZ * maxForce * 3.5;
                aliX /= total; aliY /= total; aliZ /= total;
                ax += (aliX - vel.x) * maxForce * 1.5; ay += (aliY - vel.y) * maxForce * 1.5; az += (aliZ - vel.z) * maxForce * 1.5;
                cohX /= total; cohY /= total; cohZ /= total;
                ax += (cohX - px) * maxForce * 0.008; ay += (cohY - py) * maxForce * 0.008; az += (cohZ - pz) * maxForce * 0.008;
            }

            // 目标吸引力度
            const attractStrength = mode === 'attract' ? 0.006 : 0.002;
            ax += (target.x - px) * attractStrength;
            ay += (target.y - py) * attractStrength;
            az += (target.z - pz) * attractStrength * 0.5;
        }

        vel.x += ax; vel.y += ay; vel.z += az;
        const speed = vel.length();
        if (speed > maxSpeed) vel.multiplyScalar(maxSpeed / speed);
        // 最低速度（避免静止）
        if (speed < 0.3) vel.multiplyScalar(0.3 / speed);

        boidsPositions[i * 3]     += vel.x;
        boidsPositions[i * 3 + 1] += vel.y;
        boidsPositions[i * 3 + 2] += vel.z;

        // 边界环绕
        if (boidsPositions[i * 3] > 150) boidsPositions[i * 3] = -150;
        if (boidsPositions[i * 3] < -150) boidsPositions[i * 3] = 150;
        if (boidsPositions[i * 3 + 1] > 120) boidsPositions[i * 3 + 1] = -120;
        if (boidsPositions[i * 3 + 1] < -120) boidsPositions[i * 3 + 1] = 120;
        if (boidsPositions[i * 3 + 2] > 50) boidsPositions[i * 3 + 2] = -50;
        if (boidsPositions[i * 3 + 2] < -50) boidsPositions[i * 3 + 2] = 50;

        // 更新 InstancedMesh 矩阵（位置+朝向速度方向+大小随机）
        BOIDS_DUMMY.position.set(
            boidsPositions[i * 3],
            boidsPositions[i * 3 + 1],
            boidsPositions[i * 3 + 2]
        );
        // 朝向速度方向
        const angle = Math.atan2(vel.y, vel.x);
        BOIDS_DUMMY.rotation.set(0, 0, angle);
        // 大小变化 (3~7)
        const s = 3 + (i % 5);
        // 尾巴摆动
        const tailWag = Math.sin(clock.getElapsedTime() * 6 + i * 0.5) * 0.15;
        BOIDS_DUMMY.rotation.z += tailWag;
        BOIDS_DUMMY.scale.set(s, s * 0.7, 1);
        BOIDS_DUMMY.updateMatrix();
        boidsInstancedMesh.setMatrixAt(i, BOIDS_DUMMY.matrix);
    }

    boidsInstancedMesh.instanceMatrix.needsUpdate = true;
}

function loadFinalModel() {
    // 不再加载独立的终局模型，RELEASE 阶段直接复用 fishMeshGroup
    console.log('[INFO] 放生阶段将复用钓鱼阶段的鱼模型');
}

/**
 * 显示鱼灯GLB模型（制灯阶段后期 → 点亮鱼灯时调用）
 */
let lanternGlowProgress = 0;  // 0~1 点亮渐变进度
let lanternGlowing = false;   // 是否正在点亮
let lanternPointLight = null; // 内部点光源
let lanternDisplayFillLight = null;
let lanternDisplayBackLight = null;
let personalLanternHalo = null; // 群舞中个人鱼灯的光晕
// v4.1 队形巡游状态：mode 0=一字长队 1=环形灯阵
const formationState = { t: 0, spacing: 0.3, mode: 0, modeTimer: 0 };
const _processionVec = new THREE.Vector3();

function tuneLanternDisplayMaterials(group) {
    group.traverse((obj) => {
        if (!obj.isMesh || !obj.material) return;
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        mats.forEach((mat) => {
            mat.side = THREE.DoubleSide;
            mat.shadowSide = THREE.DoubleSide;
            mat.fog = false; // 鱼灯是画面主角，不被场景雾压灰
            if (mat.roughness !== undefined) mat.roughness = Math.min(mat.roughness, 0.62); // 保留纱绸光泽
            mat.needsUpdate = true;
        });
    });
}

function setLanternDisplayLights(enabled) {
    // 领取单盏鱼灯的专属补光：对齐化光页 ParticleScene 的清晰观感
    // （夜景全局灯光为群舞调暗了，单盏大特写会欠光发灰——“模糊”的真因）
    if (!lanternDisplayFillLight) {
        lanternDisplayFillLight = new THREE.DirectionalLight(0xfff1d6, 0);
        lanternDisplayFillLight.position.set(60, 80, 140);
        scene.add(lanternDisplayFillLight);
        lanternDisplayBackLight = new THREE.DirectionalLight(0xffb37a, 0);
        lanternDisplayBackLight.position.set(-90, 40, -110);
        scene.add(lanternDisplayBackLight);
    }
    if (!enabled) {
        lanternDisplayFillLight.intensity = 0;
        lanternDisplayBackLight.intensity = 0;
        return;
    }
    // 单体展示（领取鱼灯 / 钓获展示鱼）给足光；群舞阶段只给微量（避免十盏又过曝）
    const single = currentPhase === PHASES.LANTERN_RECEIVE
        || (currentPhase === PHASES.FISHING && catchShowcaseActive);
    lanternDisplayFillLight.intensity = single ? 1.05 : 0.35;
    lanternDisplayBackLight.intensity = single ? 0.5 : 0.2;
}

// ═══════════════════════════════════════════════════════
// 2D/3D 融合层：水面伪倒影 + 接触光斑 + 接触涟漪
// 只镜像「钓获展示鱼」和「单盏领取鱼灯」——群舞 10×50k 面绝不镜像
// ═══════════════════════════════════════════════════════
let catchFishReflection = null;
let lanternReflection = null;
let contactGlowSprite = null;
let contactRippleTimer = 0;
const _contactVec = new THREE.Vector3();
const LANTERN_WATER_Y = -34;          // 夜景水线（对齐 lantern-night-bg 水面）
const CATCH_WATER_Y_OFFSET = -18;     // 展示鱼水线相对 CATCH_FISH_OFFSET.y

function createWaterReflection(sourceGroup, waterY) {
    const refl = sourceGroup.clone(true);
    const mats = [];
    refl.traverse((o) => {
        if (!o.isMesh || !o.material) return;
        o.material = Array.isArray(o.material)
            ? o.material.map((m) => m.clone())
            : o.material.clone();
        const list = Array.isArray(o.material) ? o.material : [o.material];
        list.forEach((m) => {
            m.transparent = true;
            m.depthWrite = false;
            m.side = THREE.DoubleSide; // scale.y 取负翻转绕序
            m.onBeforeCompile = (s) => {
                s.uniforms.uWaterY = { value: waterY };
                s.vertexShader = s.vertexShader
                    .replace('#include <common>', '#include <common>\nuniform float uWaterY;\nvarying float vDepthBelow;')
                    .replace('#include <project_vertex>', '#include <project_vertex>\nvDepthBelow = uWaterY - (modelMatrix * vec4(transformed, 1.0)).y;');
                s.fragmentShader = s.fragmentShader
                    .replace('#include <common>', '#include <common>\nvarying float vDepthBelow;')
                    .replace('#include <dithering_fragment>', '#include <dithering_fragment>\ngl_FragColor.a *= 0.22 * exp(-max(vDepthBelow, 0.0) * 0.06);');
            };
            mats.push(m);
        });
    });
    refl.renderOrder = -1;
    refl.userData._reflMats = mats;
    refl.userData._waterY = waterY;
    scene.add(refl);
    return refl;
}

function syncWaterReflection(refl, source, time, opacity = 1) {
    if (!refl || !source) return;
    const waterY = refl.userData._waterY;
    refl.position.set(
        source.position.x + Math.sin(time * 1.7) * 0.6, // 水光微晃
        2 * waterY - source.position.y,
        source.position.z
    );
    refl.rotation.set(-source.rotation.x, source.rotation.y, -source.rotation.z);
    refl.scale.set(source.scale.x, -Math.abs(source.scale.y), source.scale.z);
    refl.visible = source.visible;
    refl.userData._reflMats.forEach((m) => { m.opacity = opacity; });
}

function removeWaterReflection(refl) {
    if (refl) scene.remove(refl);
    return null;
}

function ensureContactGlow() {
    if (contactGlowSprite) return contactGlowSprite;
    const tex = createRadialGlowTexture('rgba(255, 200, 120, 1)', 64);
    const mat = new THREE.SpriteMaterial({
        map: tex, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false,
    });
    contactGlowSprite = new THREE.Sprite(mat);
    contactGlowSprite.visible = false;
    contactGlowSprite.layers.enable(BLOOM_LAYER);
    scene.add(contactGlowSprite);
    return contactGlowSprite;
}

function updateWaterFusion(dt, time) {
    if (!LOOK_ENABLED) return;
    // 钓获展示鱼倒影
    const showcaseFishShown = catchShowcaseActive && currentPhase === PHASES.FISHING && fishMeshGroup?.visible;
    if (showcaseFishShown) {
        if (!catchFishReflection) {
            catchFishReflection = createWaterReflection(fishMeshGroup, CATCH_FISH_OFFSET.y + CATCH_WATER_Y_OFFSET);
        }
        syncWaterReflection(catchFishReflection, fishMeshGroup, time);
    } else if (catchFishReflection) {
        catchFishReflection = removeWaterReflection(catchFishReflection);
    }
    // 领取鱼灯倒影（单盏）
    const lanternShown = lanternMeshGroup?.visible
        && lanternSummonStage === 'model'
        && currentPhase === PHASES.LANTERN_RECEIVE;
    if (lanternShown) {
        if (!lanternReflection) {
            lanternReflection = createWaterReflection(lanternMeshGroup, LANTERN_WATER_Y);
        }
        syncWaterReflection(lanternReflection, lanternMeshGroup, time, lanternModelFadeProgress * 0.9);
    } else if (lanternReflection) {
        lanternReflection = removeWaterReflection(lanternReflection);
    }
    // 接触光斑 + 接触涟漪
    const glow = ensureContactGlow();
    let target = null;
    let waterY = 0;
    let scaleBase = 0;
    if (lanternShown) {
        target = lanternMeshGroup;
        waterY = LANTERN_WATER_Y;
        scaleBase = 34;
    }
    if (target) {
        glow.visible = true;
        glow.position.set(target.position.x, waterY, target.position.z);
        // 鱼灯=烛焰闪烁；展示鱼=缓慢呼吸（快速闪烁会让卡片页的鱼「一闪一闪」）
        const pulse = target === lanternMeshGroup
            ? 0.86 + 0.1 * Math.sin(time * 7.3) + 0.04 * Math.sin(time * 13.1)
            : 0.92 + 0.08 * Math.sin(time * 1.1);
        glow.material.opacity = 0.2 * pulse * (target === lanternMeshGroup ? lanternModelFadeProgress : 1);
        glow.scale.set(scaleBase, scaleBase * 0.32, 1);
        // 接触涟漪：早段每 ~2.6s 在对象投影点注入一圈真实涟漪（复用现有波动模拟）
        contactRippleTimer += dt;
        if (contactRippleTimer > 2.6 && waterRipple
            && !document.body.classList.contains('lantern-night-stage')) {
            contactRippleTimer = 0;
            _contactVec.set(target.position.x, waterY, target.position.z).project(camera);
            const u = _contactVec.x * 0.5 + 0.5;
            const v = _contactVec.y * 0.5 + 0.5;
            if (u > 0 && u < 1 && v > 0 && v < 1) waterRipple.addRippleAt(u, v);
        }
    } else {
        glow.visible = false;
    }
}

function showLanternModel() {
    if (!lanternMeshGroup) return;
    // 隐藏鱼，显示灯
    if (fishMeshGroup) fishMeshGroup.visible = false;
    lanternMeshGroup.visible = true;
    lanternMeshGroup.position.set(0, 0, 0);
    lanternMeshGroup.rotation.set(0, Math.PI / 2, 0);
    // 使用鱼灯自身经过包围盒适配后的尺寸，避免被鱼影缩放值压得过小
    if (lanternMeshGroup.userData._lanternBaseScale) {
        lanternMeshGroup.scale.copy(lanternMeshGroup.userData._lanternBaseScale);
    }
    tuneLanternDisplayMaterials(lanternMeshGroup);
    lanternModelFadeProgress = 0;
    // 一次 traverse 同时缓存全部材质 / 发光材质，后续每帧动画不再遍历 5 万面模型
    const allMats = [];
    const emissiveMats = [];
    lanternMeshGroup.traverse((obj) => {
        if (!obj.isMesh || !obj.material) return;
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        mats.forEach((mat) => {
            mat.transparent = true;
            mat.opacity = 0;
            allMats.push(mat);
            if (mat.emissive) emissiveMats.push(mat);
        });
    });
    lanternMeshGroup.userData._allMats = allMats;
    lanternMeshGroup.userData._emissiveMats = emissiveMats;
    lanternMeshGroup.userData._candlePhase = Math.random() * Math.PI * 2;
    // 不再用相机 autoRotate（会带着星空转）——改为鱼灯自身缓慢自转（见 animate）

    // 保留 GLB 原始材质 + 专属展示补光（对齐化光页观感）
    setLanternDisplayLights(true);
    lanternGlowing = false;
    lanternGlowProgress = 0;
    // 添加内部暖光点光源
    if (!lanternPointLight) {
        lanternPointLight = new THREE.PointLight(0xffaa44, 0, 80);
        scene.add(lanternPointLight);
    }
    lanternPointLight.position.set(0, 0, 0);
    lanternPointLight.intensity = 0.62;
}

function hideLanternModel() {
    if (lanternMeshGroup) lanternMeshGroup.visible = false;
    setLanternDisplayLights(false);
}

function clearLanternDanceTimers() {
    if (lanternReadyTimer) {
        clearTimeout(lanternReadyTimer);
        lanternReadyTimer = null;
    }
    if (lanternDanceHintTimer) {
        clearTimeout(lanternDanceHintTimer);
        lanternDanceHintTimer = null;
    }
    if (lanternAutoReleaseTimer) {
        clearTimeout(lanternAutoReleaseTimer);
        lanternAutoReleaseTimer = null;
    }
    if (lanternParticleCompleteTimer) {
        clearTimeout(lanternParticleCompleteTimer);
        lanternParticleCompleteTimer = null;
    }
}

function clearLanternDanceGroup() {
    if (lanternDanceGroup) scene.remove(lanternDanceGroup);
    lanternDanceGroup = null;
    lanternDanceInstances = [];
    if (personalLanternHalo) personalLanternHalo.visible = false;
    if (!lanternMeshGroup?.visible) setLanternDisplayLights(false);
}

function cloneLanternForDance(template) {
    const clone = template.clone(true);
    const emissiveMats = []; // 克隆时缓存发光材质，避免每帧 traverse 5 万面模型
    clone.traverse((obj) => {
        if (!obj.isMesh || !obj.material) return;
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        obj.material = Array.isArray(obj.material)
            ? mats.map((mat) => mat.clone())
            : obj.material.clone();
        const newMats = Array.isArray(obj.material) ? obj.material : [obj.material];
        newMats.forEach((mat) => {
            if (!mat.emissive) return;
            // GLB 默认黑色 emissive 时补暖烛色，否则闪烁不可见
            if (mat.emissive.r + mat.emissive.g + mat.emissive.b < 0.01) {
                mat.emissive.setRGB(0.34, 0.2, 0.06);
            }
            emissiveMats.push(mat);
        });
    });
    clone.userData._emissiveMats = emissiveMats;
    tuneLanternDisplayMaterials(clone);
    // 鱼灯也是鱼形——注入轻幅泳动（纱绸般的身体波），告别刚性漂浮
    // 注意顺序：在 tuneLanternDisplayMaterials 之后注入，避免 needsUpdate 抹掉注入
    const swim = applySwimDeformation(clone, {
        speed: 1.05, amplitude: 0.018, frequency: 0.82, tailBias: 1.6,
    });
    clone.userData._swimUniforms = swim.uniforms;
    // 灯影流彩（v4.1）：纱面色相沿身体缓慢流动，像烛光透过彩纱
    const flowU = { uFlowTime: { value: 0 }, uFlowStrength: { value: 0.12 } }; // 收敛流彩强度，避免灯群闪烁感过重
    clone.traverse((obj) => {
        if (!obj.isMesh || !obj.material) return;
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        mats.forEach((mat) => applyLanternColorFlow(mat, flowU));
    });
    clone.userData._flowUniforms = flowU;
    return clone;
}

// 灯影流彩：包一层现有 onBeforeCompile（与泳动注入共存），
// fragment 末端按身体坐标+时间做 YIQ 色相旋转（±uFlowStrength 弧度）
function applyLanternColorFlow(mat, flowU) {
    const prev = mat.onBeforeCompile;
    mat.onBeforeCompile = (shader) => {
        if (prev) prev(shader);
        shader.uniforms.uFlowTime = flowU.uFlowTime;
        shader.uniforms.uFlowStrength = flowU.uFlowStrength;
        // 身体坐标 varying：复用泳动注入声明的 uAxisSel/uZMin/uZLen
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', '#include <common>\nvarying float vFlowBody;')
            .replace('#include <fog_vertex>', `#include <fog_vertex>
                {
                    float fc = uAxisSel < 1.0 ? position.x : position.z;
                    float fb = clamp((fc - uZMin) / uZLen, 0.0, 1.0);
                    if (uAxisSel >= 1.0) fb = 1.0 - fb;
                    vFlowBody = fb;
                }`);
        shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', `#include <common>
                varying float vFlowBody;
                uniform float uFlowTime;
                uniform float uFlowStrength;
                vec3 lanternHueShift(vec3 color, float a) {
                    const vec3 k = vec3(0.57735);
                    float cs = cos(a);
                    float sn = sin(a);
                    return color * cs + cross(k, color) * sn + k * dot(k, color) * (1.0 - cs);
                }`)
            .replace('#include <dithering_fragment>', `#include <dithering_fragment>
                gl_FragColor.rgb = lanternHueShift(gl_FragColor.rgb,
                    sin(vFlowBody * 6.2832 - uFlowTime) * uFlowStrength);`);
    };
    mat.needsUpdate = true;
}

// 灯会光晕 sprite（bloom 关掉也有八成效果；真 bloom 开启时两者叠加）
// 刻意收敛：太大太浓会让鱼灯整体发雾
function createLanternHalo(worldRadius) {
    const tex = createRadialGlowTexture('rgba(255, 200, 120, 1)', 128);
    const mat = new THREE.SpriteMaterial({
        map: tex, transparent: true, opacity: 0.13,
        blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.setScalar(worldRadius * 1.9);
    sprite.layers.enable(BLOOM_LAYER);
    return sprite;
}

function getHighDetailLanternUrl(fishIdx) {
    return HIGH_DETAIL_LANTERN_MODELS[fishIdx] || HIGH_DETAIL_LANTERN_MODELS[0];
}

async function loadHighDetailLanternTemplate(fishIdx) {
    const url = getHighDetailLanternUrl(fishIdx);
    if (!highDetailLanternCache.has(url)) {
        highDetailLanternCache.set(url, loadGLBMesh(url, 90));
    }
    return highDetailLanternCache.get(url);
}

async function spawnLanternDanceGroup() {
    clearLanternDanceGroup();
    lanternDanceGroup = new THREE.Group();
    scene.add(lanternDanceGroup);
    setLanternDisplayLights(true);

    const templates = await Promise.all(FISH_TYPES.map((_, fishIdx) => loadHighDetailLanternTemplate(fishIdx)));
    const layouts = [
        [-96, 48, -26], [-66, 68, -10],
        [-42, 38, 2], [-12, 62, -22],
        [18, 44, -4], [48, 70, -18],
        [76, 40, -2], [102, 62, -30],
        [-82, 82, -38], [88, 86, -42],
    ];
    layouts.forEach((layout, index) => {
        const mesh = cloneLanternForDance(templates[index % FISH_TYPES.length]);
        const baseScale = mesh.scale.clone().multiplyScalar(0.24 + (index % 4) * 0.035);
        const side = index % 2 === 0 ? -1 : 1;
        const basePosition = new THREE.Vector3(layout[0], layout[1], layout[2]);
        mesh.visible = true;
        mesh.scale.copy(baseScale);
        mesh.position.set(basePosition.x + side * 105, basePosition.y + 42, basePosition.z - 18);
        mesh.rotation.set(0, Math.PI / 2 + side * 0.16, 0);
        lanternDanceGroup.add(mesh);
        // 暖金光晕（独立加入群组，每帧跟随实例位置）
        const radius = new THREE.Box3().setFromObject(mesh).getBoundingSphere(new THREE.Sphere()).radius;
        const halo = createLanternHalo(Math.max(8, radius));
        halo.position.copy(mesh.position);
        lanternDanceGroup.add(halo);
        lanternDanceInstances.push({
            mesh,
            halo,
            emissiveMats: mesh.userData._emissiveMats || [],
            flickerPhase: Math.random() * Math.PI * 2,
            basePosition,
            followOffset: new THREE.Vector2(),
            pos: mesh.position.clone(),
            velocity: new THREE.Vector3((Math.random() - 0.5) * 8, (Math.random() - 0.5) * 4, 0),
            acceleration: new THREE.Vector3(),
            flockReady: false,
            delay: index * 0.48,
            speed: 0.34 + (index % 5) * 0.075,
            floatAmp: 3.5 + (index % 3) * 1.6,
            swayAmp: 5.5 + (index % 4) * 2.1,
            phase: index * 0.82,
            rotationOffset: side * 0.16,
        });
    });
}

async function enterLanternDance() {
    if (lanternSummonStage !== 'model') return;
    lanternReadyTimer = null;
    currentPhase = PHASES.LANTERN_SWARM;
    updatePhaseIndicator();
    lanternSummonStage = 'danceArriving';
    lanternDanceReleased = false;
    lanternDanceReleaseProgress = 0;
    lanternMergeReturnScheduled = false;
    lanternDanceGesture = { sawFist: false, openFrames: 0 };
    lanternSwarmControl.rawTarget.set(0, 0);
    lanternSwarmControl.target.set(0, 0);
    lanternSwarmControl.current.set(0, 0);
    lanternSwarmControl.velocity.set(0, 0);
    lanternSwarmControl.active = false;
    lanternSwarmControl.lastMoveAt = 0;
    if (lanternAutoReleaseTimer) {
        clearTimeout(lanternAutoReleaseTimer);
        lanternAutoReleaseTimer = null;
    }
    setLanternNightMode(true);
    if (particleSystem) particleSystem.visible = false;
    if (lanternMeshGroup) {
        lanternMeshGroup.visible = true;
        lanternMeshGroup.position.set(0, -24, 26);
        lanternMeshGroup.userData._danceBaseScale = (lanternMeshGroup.userData._lanternBaseScale || lanternMeshGroup.scale).clone();
        lanternMeshGroup.userData._flockPos = null;
        lanternMeshGroup.userData._flockVelocity = null;
        lanternMeshGroup.scale.copy(lanternMeshGroup.userData._danceBaseScale).multiplyScalar(0.72);
        // 个人鱼灯也要光晕（与群里其他 9 盏一致——「我们的鱼没有雾」）
        if (!personalLanternHalo) {
            personalLanternHalo = createLanternHalo(10);
            scene.add(personalLanternHalo);
        }
        const haloRadius = new THREE.Box3().setFromObject(lanternMeshGroup)
            .getBoundingSphere(new THREE.Sphere()).radius;
        lanternMeshGroup.userData._haloBase = Math.max(10, haloRadius) * 1.9;
        lanternMeshGroup.userData._haloRefScale = lanternMeshGroup.scale.x;
        personalLanternHalo.visible = true;
    }
    controls.autoRotate = false;
    camera.position.set(0, 10, 188);
    controls.target.set(0, 18, 0);
    controls.update();
    updateLanternSummonCopy('舞鱼灯 · 灯群巡游', 'TEN LANTERNS ARRIVE ACROSS THE NIGHT SKY');
    const summonBtn = document.getElementById('lantern-summon-btn');
    if (summonBtn) summonBtn.disabled = true;
    await spawnLanternDanceGroup();
    lanternDanceStartedAt = performance.now();
    // 入场后很快即可放飞（原 10s 死区缩短为 3.5s；且放飞手势在入场期间即可响应，见下）
    lanternDanceHintTimer = setTimeout(() => {
        lanternDanceHintTimer = null;
        if (lanternSummonStage !== 'danceArriving') return;
        lanternSummonStage = 'danceReleaseReady';
        updateLanternSummonCopy('请握拳张开手掌，放飞鱼灯', 'MAKE A FIST, THEN OPEN YOUR PALM TO RELEASE');
        if (summonBtn) {
            summonBtn.disabled = false;
            summonBtn.querySelector('span').textContent = '放飞鱼灯';
            summonBtn.querySelector('small').textContent = 'FIST THEN OPEN';
        }
    }, 3500);
}

// 全屏暖光 flash（放飞瞬间，1.2s 淡出）
function flashWarmScreen() {
    const flash = document.createElement('div');
    flash.style.cssText = 'position:fixed;inset:0;z-index:11900;pointer-events:none;'
        + 'background:radial-gradient(circle at 50% 55%, rgba(255,190,90,0.28), transparent 70%);'
        + 'opacity:1;transition:opacity 1.2s ease;';
    document.body.appendChild(flash);
    requestAnimationFrame(() => { flash.style.opacity = '0'; });
    setTimeout(() => flash.remove(), 1400);
}

function releaseUserLantern() {
    if (lanternSummonStage !== 'danceReleaseReady' || lanternDanceReleased) return;
    lanternDanceReleased = true;
    lanternSummonStage = 'danceMerging';
    lanternDanceReleaseProgress = 0;
    const summonBtn = document.getElementById('lantern-summon-btn');
    if (summonBtn) summonBtn.disabled = true;
    updateLanternSummonCopy('鱼灯汇入灯群，照亮水乡夜色', 'YOUR LANTERN JOINS THE DANCING LIGHTS');
    playRitualSfx('release');
    void setBgmTrack('fireworks', { restart: true });
    // 放飞瞬间 = 全片视觉顶点：金色烟花 + 曝光/bloom 脉冲 + 暖光 flash
    if (LOOK_ENABLED) {
        const origin = lanternMeshGroup?.visible
            ? lanternMeshGroup.position.clone()
            : new THREE.Vector3(0, 20, 0);
        const t = clock ? clock.getElapsedTime() : 0;
        for (let i = 0; i < 3; i++) spawnMiniFirework(t, 'yellow', null, origin);
        exposurePulse = 1; // updatePhaseLook 中以 1-dt*1.4 衰减，同时推高 bloom strength
        flashWarmScreen();
    }
}

function updateLanternDanceGesture(fingersUp) {
    if (lanternSummonStage !== 'danceReleaseReady') return;
    if (fingersUp <= 1) {
        lanternDanceGesture.sawFist = true;
        lanternDanceGesture.openFrames = 0;
        setGestureProgress(0.06, '✊'); // 握拳已识别，提示「现在张开」
        return;
    }
    if (lanternDanceGesture.sawFist && fingersUp >= 4) {
        lanternDanceGesture.openFrames++;
        setGestureProgress(0.1 + (lanternDanceGesture.openFrames / 8) * 0.9, '✋');
        if (lanternDanceGesture.openFrames >= 8) {
            setGestureProgress(0);
            releaseUserLantern();
        }
    }
}

function updateLanternSwarmFollow(palmX, palmY, isOpenPalm) {
    const canFollow =
        currentPhase === PHASES.LANTERN_SWARM &&
        lanternDanceReleased &&
        lanternDanceReleaseProgress >= 0.95;
    if (!canFollow || !isOpenPalm) {
        lanternSwarmControl.active = false;
        return;
    }

    // MediaPipe x/y: 0=画面左/上, 1=画面右/下。映射到舞台平面，带小死区过滤识别噪声。
    const normalizedX = THREE.MathUtils.clamp((0.5 - palmX) * 2, -1, 1);
    const normalizedY = THREE.MathUtils.clamp((0.5 - palmY) * 2, -1, 1);
    const deadzonedX = Math.abs(normalizedX) < 0.06 ? 0 : normalizedX;
    const deadzonedY = Math.abs(normalizedY) < 0.07 ? 0 : normalizedY;
    lanternSwarmControl.rawTarget.set(deadzonedX * 132, deadzonedY * 82);
    lanternSwarmControl.active = true;
    lanternSwarmControl.lastMoveAt = performance.now();
}

function limitVectorLength(v, maxLen) {
    const lenSq = v.lengthSq();
    if (lenSq > maxLen * maxLen) v.multiplyScalar(maxLen / Math.sqrt(lenSq));
    return v;
}

function arrivalSteer(pos, velocity, target, slowingRadius, maxSpeed, maxForce) {
    const desired = target.clone().sub(pos);
    const dist = desired.length();
    if (dist < 0.001) return new THREE.Vector3();
    const speed = dist < slowingRadius
        ? THREE.MathUtils.mapLinear(dist, 0, slowingRadius, 0, maxSpeed)
        : maxSpeed;
    desired.multiplyScalar(speed / dist);
    return limitVectorLength(desired.sub(velocity), maxForce);
}

function updateLanternFlock(dt, time, follow) {
    const cfg = LANTERN_FLOCK;
    const stepDt = Math.min(dt, 1 / 20);

    lanternDanceInstances.forEach((inst) => {
        if (!inst.flockReady) {
            inst.pos.copy(inst.mesh.position);
            inst.velocity.set((Math.random() - 0.5) * 10, (Math.random() - 0.5) * 5, 0);
            inst.acceleration.set(0, 0, 0);
            inst.flockReady = true;
        }

        const separation = new THREE.Vector3();
        const alignment = new THREE.Vector3();
        const cohesion = new THREE.Vector3();
        let sepCount = 0;
        let neighborCount = 0;

        lanternDanceInstances.forEach((other) => {
            if (other === inst || !other.flockReady) return;
            const diff = inst.pos.clone().sub(other.pos);
            const dist = diff.length();
            if (dist < 0.001 || dist > cfg.neighborRadius) return;

            alignment.add(other.velocity);
            cohesion.add(other.pos);
            neighborCount++;

            if (dist < cfg.separationRadius) {
                separation.add(diff.multiplyScalar(1 / (dist * dist)));
                sepCount++;
            }
        });

        if (sepCount > 0) {
            separation.divideScalar(sepCount).normalize().multiplyScalar(cfg.maxSpeed).sub(inst.velocity);
            limitVectorLength(separation, cfg.maxForce);
        }
        if (neighborCount > 0) {
            alignment.divideScalar(neighborCount).normalize().multiplyScalar(cfg.maxSpeed).sub(inst.velocity);
            limitVectorLength(alignment, cfg.maxForce * 0.65);

            cohesion.divideScalar(neighborCount);
            cohesion.copy(arrivalSteer(inst.pos, inst.velocity, cohesion, cfg.neighborRadius, cfg.maxSpeed * 0.65, cfg.maxForce * 0.55));
        }

        const homeTarget = inst.basePosition.clone();
        homeTarget.x += follow.x;
        homeTarget.y += follow.y;
        homeTarget.z += -8 + Math.sin(time * 0.38 + inst.phase) * 3.5;
        const handArrival = arrivalSteer(inst.pos, inst.velocity, homeTarget, cfg.arrivalRadius, cfg.maxSpeed, cfg.maxForce);

        inst.acceleration.set(0, 0, 0);
        inst.acceleration.addScaledVector(separation, cfg.separationWeight);
        inst.acceleration.addScaledVector(alignment, cfg.alignmentWeight);
        inst.acceleration.addScaledVector(cohesion, cfg.cohesionWeight);
        inst.acceleration.addScaledVector(handArrival, cfg.handAttractionWeight);
        limitVectorLength(inst.acceleration, cfg.maxForce);

        inst.velocity.addScaledVector(inst.acceleration, stepDt);
        inst.velocity.multiplyScalar(Math.max(0, 1 - 1.35 * stepDt));
        limitVectorLength(inst.velocity, cfg.maxSpeed);
        inst.pos.addScaledVector(inst.velocity, stepDt);

        const floatY = Math.sin(time * inst.speed * 1.25 + inst.phase) * 1.4;
        inst.mesh.position.set(inst.pos.x, inst.pos.y + floatY, inst.pos.z);
        const heading = Math.atan2(inst.velocity.x, Math.max(8, Math.abs(inst.velocity.y) + 18));
        inst.mesh.rotation.y = Math.PI / 2 + inst.rotationOffset + THREE.MathUtils.clamp(heading, -0.22, 0.22);
        inst.mesh.rotation.z = Math.sin(time * inst.speed + inst.phase) * 0.018;
    });
}

function updateLanternDanceAnimation(dt, time) {
    if (!lanternSummonStage.startsWith('dance')) return;
    const elapsed = (performance.now() - lanternDanceStartedAt) / 1000;
    const isMergingLantern = lanternDanceReleased && lanternDanceReleaseProgress < 0.98;
    if (!lanternSwarmControl.active && (performance.now() - lanternSwarmControl.lastMoveAt) > 900) {
        lanternSwarmControl.rawTarget.multiplyScalar(Math.max(0, 1 - dt * 0.7));
    }
    lanternSwarmControl.target.lerp(lanternSwarmControl.rawTarget, Math.min(1, dt * 8.0));
    lanternSwarmControl.current.lerp(lanternSwarmControl.target, Math.min(1, dt * 6.5));
    const follow = lanternSwarmControl.current;
    const followPower = THREE.MathUtils.clamp(follow.length() / 150, 0, 1);
    const followDir = follow.x >= 0 ? 1 : -1;

    if (lanternDanceReleased && lanternDanceReleaseProgress >= 0.98) {
        updateLanternFlock(dt, time, follow);
    } else {
    // v4.1 队形巡游：十盏灯沿 Lissajous 河道路线鱼贯而行，
    // 每 20 秒在「一字长队」⇄「环形灯阵」间平滑切换（本质=间距插值）
    formationState.t += dt * (isMergingLantern ? 0.018 : (0.16 + followPower * 0.05));
    if (!isMergingLantern) formationState.modeTimer += dt;
    if (!isMergingLantern && formationState.modeTimer > 20) {
        formationState.modeTimer = 0;
        formationState.mode = 1 - formationState.mode;
    }
    const targetSpacing = formationState.mode === 0 ? 0.3 : (Math.PI * 2) / 10;
    formationState.spacing += (targetSpacing - formationState.spacing) * Math.min(1, dt * 0.6);
    lanternDanceInstances.forEach((inst, index) => {
        const localTime = Math.max(0, elapsed - inst.delay);
        const arrival = Math.min(1, localTime / 2.8);
        const eased = 1 - Math.pow(1 - arrival, 3);
        const followLag = Math.min(1, dt * (isMergingLantern ? 0.22 : (0.78 + (index % 5) * 0.1)));
        if (isMergingLantern) {
            inst.followOffset.multiplyScalar(1 - followLag);
        } else {
            inst.followOffset.lerp(follow, followLag);
        }
        // 队列参数：领头灯在前，后灯按间距跟随
        const s = formationState.t - index * formationState.spacing;
        _processionVec.set(
            Math.sin(s) * 112,
            52 + Math.sin(s * 2) * 15,
            -16 + Math.cos(s) * 13
        );
        const targetX = _processionVec.x + inst.followOffset.x;
        const targetY = _processionVec.y
            + Math.sin(time * inst.speed * 0.75 + inst.phase) * inst.floatAmp * (isMergingLantern ? 0 : 0.18)
            + inst.followOffset.y * 0.8;
        const targetZ = _processionVec.z;
        const startX = inst.basePosition.x + (index % 2 === 0 ? -105 : 105);
        const prevX = inst.mesh.position.x;
        const prevZ = inst.mesh.position.z;
        inst.mesh.position.set(
            THREE.MathUtils.lerp(startX, targetX, eased),
            THREE.MathUtils.lerp(inst.basePosition.y + 42, targetY, eased),
            THREE.MathUtils.lerp(inst.basePosition.z - 18, targetZ, eased)
        );
        if (lanternDanceReleased) {
            inst.mesh.position.y += lanternDanceReleaseProgress * 24;
            inst.mesh.position.z -= lanternDanceReleaseProgress * 10;
        }
        // 机头对准前进方向（有限差分求航向，平滑转向 + 入弯滚转 + 身体 C 弯）
        const moveX = inst.mesh.position.x - prevX;
        const moveZ = inst.mesh.position.z - prevZ;
        if (inst.yaw === undefined) inst.yaw = Math.PI / 2 + inst.rotationOffset;
        const turnThreshold = isMergingLantern ? 0.00018 : 1e-6;
        if (moveX * moveX + moveZ * moveZ > turnThreshold) {
            const desired = Math.atan2(moveX, moveZ);
            let dyaw = desired - inst.yaw;
            dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
            inst.yaw += dyaw * Math.min(1, dt * (isMergingLantern ? 0.6 : 2.6));
            inst._turn = THREE.MathUtils.clamp(dyaw, -0.55, 0.55);
        } else if (isMergingLantern) {
            inst._turn = (inst._turn || 0) * Math.max(0, 1 - dt * 3);
        }
        inst.mesh.rotation.y = inst.yaw;
        inst.mesh.rotation.z = -(inst._turn || 0) * (isMergingLantern ? 0.05 : 0.18)
            + Math.sin(time * inst.speed * 0.7 + inst.phase) * (isMergingLantern ? 0 : 0.007);
    });
    }

    // 灯会层：光晕跟随 + 烛光 emissive 闪烁（材质已在 clone 时缓存，零 traverse）
    lanternDanceInstances.forEach((inst) => {
        const flicker = 0.72
            + 0.035 * Math.sin(time * 3.4 + inst.flickerPhase)
            + 0.015 * Math.sin(time * 6.2 + inst.flickerPhase * 1.7);
        if (inst.halo) {
            inst.halo.position.copy(inst.mesh.position);
            inst.halo.material.opacity = 0.075 * flicker;
        }
        inst.emissiveMats.forEach((mat) => { mat.emissiveIntensity = 0.11 * flicker; });
        // 纱绸泳动：每盏灯相位错开 + 转弯 C 弯
        const swimU = inst.mesh.userData._swimUniforms;
        if (swimU) {
            swimU.uSwimTime.value = time * (isMergingLantern ? 0.18 : 0.58) + inst.flickerPhase;
            const turnTarget = (inst._turn || 0) * (isMergingLantern ? 0.025 : 0.1);
            swimU.uTurnBend.value += (turnTarget - swimU.uTurnBend.value) * Math.min(1, dt * (isMergingLantern ? 1.2 : 2.4));
        }
        // 灯影流彩：色相沿身体流动，各灯相位错开
        const flowU = inst.mesh.userData._flowUniforms;
        if (flowU) flowU.uFlowTime.value = time * (isMergingLantern ? 0.18 : 0.55) + inst.flickerPhase * 1.4;
    });

    if (!lanternMeshGroup?.visible) return;
    if (!lanternDanceReleased) {
        lanternMeshGroup.position.x = Math.sin(time * 0.55) * 4;
        lanternMeshGroup.position.y = -24 + Math.sin(time * 0.8) * 2.4;
        lanternMeshGroup.rotation.y = Math.PI / 2 + Math.sin(time * 0.5) * 0.12;
        return;
    }
    lanternDanceReleaseProgress = Math.min(1, lanternDanceReleaseProgress + dt / 4.8);
    const eased = 1 - Math.pow(1 - lanternDanceReleaseProgress, 3);
    const personalBase = new THREE.Vector3(18, 63, -10);
    if (lanternDanceReleaseProgress < 0.98) {
        lanternMeshGroup.position.lerpVectors(new THREE.Vector3(0, -24, 26), personalBase, eased);
    } else {
        if (!lanternMeshGroup.userData._flockPos) {
            lanternMeshGroup.userData._flockPos = lanternMeshGroup.position.clone();
            lanternMeshGroup.userData._flockVelocity = new THREE.Vector3();
        }
        const personalTarget = personalBase.clone();
        personalTarget.x += follow.x;
        personalTarget.y += follow.y;
        personalTarget.z += Math.sin(time * 0.34) * 2.4;
        const vel = lanternMeshGroup.userData._flockVelocity;
        const pos = lanternMeshGroup.userData._flockPos;
        const steer = arrivalSteer(pos, vel, personalTarget, LANTERN_FLOCK.arrivalRadius, LANTERN_FLOCK.maxSpeed * 0.96, LANTERN_FLOCK.maxForce * 0.9);
        const stepDt = Math.min(dt, 1 / 20);
        vel.addScaledVector(steer, stepDt);
        vel.multiplyScalar(Math.max(0, 1 - 1.45 * stepDt));
        limitVectorLength(vel, LANTERN_FLOCK.maxSpeed * 0.96);
        pos.addScaledVector(vel, stepDt);
        lanternMeshGroup.position.copy(pos);
        lanternMeshGroup.position.y += Math.sin(time * 1.05) * 0.9;
    }
    lanternMeshGroup.scale.copy(lanternMeshGroup.userData._danceBaseScale).multiplyScalar(THREE.MathUtils.lerp(0.72, 0.34, eased));
    lanternMeshGroup.rotation.y = Math.PI / 2 + Math.sin(time * 0.9) * 0.16
        + followDir * followPower * 0.08
        + Math.sin(time * 1.8) * followPower * 0.035;
    lanternMeshGroup.rotation.z = Math.sin(time * 1.7) * followPower * 0.025;
    if (lanternDanceReleaseProgress >= 1) {
        updateLanternSummonCopy('张开手掌带灯群游动 · 比出 OK 回到水面', 'GUIDE WITH YOUR PALM · MAKE AN OK GESTURE TO RESTART');
        if (!lanternMergeReturnScheduled) {
            lanternMergeReturnScheduled = true;
            showKeepsakeMoment(); // 留灯仪式：高潮后的收束余韵
            // 主推进改为比 OK 回水面；45s 自动回退仅作无人值守兜底
            setTimeout(() => {
                if (currentPhase === PHASES.LANTERN_SWARM) {
                    hideFinalModel();
                    currentStage = 0;
                    applyFishTextures(currentFishIndex, 0);
                    transitionToPhase(PHASES.WATER); // 循环回到水面（墨晕转场）
                }
            }, 45000);
        }
    }
}

// 留灯仪式：鱼灯汇入灯群后，大字收束文案 + 印章，8 秒后淡出
function showKeepsakeMoment() {
    document.getElementById('keepsake-moment')?.remove();
    const name = getCurrentLanternName();
    const el = document.createElement('div');
    el.id = 'keepsake-moment';
    el.innerHTML = `
        <p class="km-kicker">灯落人间 · LANTERN KEPT</p>
        <h2 class="km-title">你的「${name}」</h2>
        <p class="km-sub">已点亮顺德水乡的夜色</p>
        <span class="seal-stamp km-seal" aria-hidden="true">願</span>`;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => {
        el.classList.remove('show');
        setTimeout(() => el.remove(), 1000);
    }, 8000);
}

async function showLanternReceivePreview() {
    clearLanternDanceTimers();
    clearLanternDanceGroup();
    setLanternNightMode(true);
    document.getElementById('ritual-cue')?.classList.add('is-hidden');
    hideAllFishMeshes();
    if (particleSystem) particleSystem.visible = false;
    if (fishSchool) { scene.remove(fishSchool.container); fishSchool = null; }
    await loadLanternMesh(currentFishIndex);
    lanternSummonStage = 'particles';
    lanternSummonSweep = { lastX: null, travel: 0, stableFrames: 0, lastAt: performance.now() };
    if (lanternMeshGroup) lanternMeshGroup.visible = false;
    document.body.classList.add('particle-receive-stage');
    await activateParticleScene();
    // 倒计时已移除：观众比 OK（或点按钮）才凝成鱼灯；手势细节由底部三步引导承担
    updateLanternSummonCopy('鱼影化灯 · 与星光共舞', 'YOUR LANTERN IS TAKING SHAPE');
    const summonBtn = document.getElementById('lantern-summon-btn');
    if (summonBtn) {
        summonBtn.disabled = false;
        summonBtn.querySelector('span').textContent = '凝成鱼灯';
        summonBtn.querySelector('small').textContent = 'SHOW 3D LANTERN';
    }
}

function completeLanternParticleReceive() {
    if (lanternSummonStage !== 'particles') return;
    clearLanternDanceTimers();
    deactivateParticleScene();
    lanternSummonStage = 'model';
    showLanternModel();
    lanternGlowing = true; // 点亮仪式：2.5s 烛光由暗到亮（v3 一直没触发——「没有点亮环节」的原因）
    lanternGlowProgress = 0;
    playRitualSfx(4);
    updateLanternSummonCopy('请比出 OK 手势，确认领取', 'MAKE AN OK GESTURE TO CLAIM');
    const summonBtn = document.getElementById('lantern-summon-btn');
    if (summonBtn) {
        summonBtn.disabled = false;
        summonBtn.querySelector('span').textContent = 'OK 确认领取';
        summonBtn.querySelector('small').textContent = 'CONFIRM TO ENTER LANTERN SWARM';
    }
}

async function showLanternSwarmPreview() {
    clearLanternDanceTimers();
    clearLanternDanceGroup();
    setLanternNightMode(true);
    document.getElementById('ritual-cue')?.classList.add('is-hidden');
    hideAllFishMeshes();
    if (particleSystem) particleSystem.visible = false;
    await loadLanternMesh(currentFishIndex);
    lanternSummonStage = 'model';
    showLanternModel();
    await enterLanternDance();
}

function showFinalModel() {
    isFinalModelVisible = true;
    isBoidsMode = false;
    if (particleSystem) particleSystem.visible = false;
    if (boidsGroup) boidsGroup.visible = false;
    // 显示 GLB 模型
    if (fishMeshGroup) {
        fishMeshGroup.visible = true;
        fishMeshGroup.position.set(0, 0, 0);
        fishMeshGroup.rotation.set(0, 0, 0);
    }
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.55;
    controls.target.set(0, 0, 0);
    camera.position.set(0, 18, 170);
    controls.update();

    const cue = document.getElementById('ritual-cue');
    if (cue) cue.classList.add('is-hidden');
}

function hideFinalModel() {
    isFinalModelVisible = false;
    if (fishMeshGroup) fishMeshGroup.visible = false;
    controls.target.set(0, 0, 0);
    controls.autoRotateSpeed = 0.3;
}

// ═══════════════════════════════════════════════════════
// 水波纹背景 + 浮游微光粒子
// ═══════════════════════════════════════════════════════
let rippleMesh, rippleScene, rippleCamera;
function createBackgroundParticles() {
    // 1. 浮游微光粒子（3D 场景内）
    const count = 3000;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    for (let i = 0; i < count; i++) {
        pos[i * 3]     = (Math.random() - 0.5) * 500;
        pos[i * 3 + 1] = (Math.random() - 0.5) * 500;
        pos[i * 3 + 2] = (Math.random() - 0.5) * 400;
        sizes[i] = 0.3 + Math.random() * 1.2;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('size', new THREE.BufferAttribute(sizes, 1));

    const mat = new THREE.PointsMaterial({
        size: 1.0,
        color: 0x4488bb,
        transparent: true,
        opacity: 0.32,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        sizeAttenuation: true,
    });

    ambientBackgroundParticles = new THREE.Points(geo, mat);
    ambientBackgroundParticles.frustumCulled = false;
    scene.add(ambientBackgroundParticles);

    createNightSparkles();

    // 2. 物理水波纹系统（屏幕空间，独立于3D场景）
    waterRipple = new WaterRipple(renderer, camera);
    waterRipple.loadWatercolorBackground('./assets/fishing-bg.png');
    waterRipple.resize(window.innerWidth, window.innerHeight);
    
    // 创建独立的正交场景用于渲染水波纹全屏背景
    rippleScene = new THREE.Scene();
    rippleCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    
    const rippleGeo = new THREE.PlaneGeometry(2, 2);
    const rippleMat = new THREE.MeshBasicMaterial({
        map: waterRipple.getOutputTexture(),
        depthWrite: false,
        depthTest: false,
        toneMapped: false, // 水彩背景是已授权图像，不做二次 ACES 调色
    });
    rippleMesh = new THREE.Mesh(rippleGeo, rippleMat);
    rippleScene.add(rippleMesh);
}

function createNightSparkles() {
    const count = 760;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const baseColors = new Float32Array(count * 3);
    const phases = new Float32Array(count);
    const speeds = new Float32Array(count);
    for (let i = 0; i < count; i++) {
        const i3 = i * 3;
        pos[i3] = (Math.random() - 0.5) * 460;
        pos[i3 + 1] = -10 + Math.random() * 170;
        pos[i3 + 2] = -35 - Math.random() * 95;
        const warm = Math.random();
        baseColors[i3] = 0.58 + warm * 0.42;
        baseColors[i3 + 1] = 0.72 + warm * 0.22;
        baseColors[i3 + 2] = 0.95;
        colors[i3] = baseColors[i3] * 0.45;
        colors[i3 + 1] = baseColors[i3 + 1] * 0.45;
        colors[i3 + 2] = baseColors[i3 + 2] * 0.45;
        phases[i] = Math.random() * Math.PI * 2;
        speeds[i] = 0.65 + Math.random() * 1.55;
    }
    // 灯会暖化标记：~70% 火花会随 sparkleWarmth 转暖金，30% 留冷蓝作纵深对比
    const warmFlags = new Float32Array(count);
    for (let i = 0; i < count; i++) warmFlags[i] = Math.random() < 0.7 ? 1 : 0;
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const mat = new THREE.PointsMaterial({
        size: 2.05,
        vertexColors: true,
        transparent: true,
        opacity: 0.0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        sizeAttenuation: false,
    });
    nightSparkles = new THREE.Points(geo, mat);
    nightSparkles.frustumCulled = false;
    nightSparkles.userData = { baseColors, phases, speeds, warmFlags };
    nightSparkles.layers.enable(BLOOM_LAYER);
    scene.add(nightSparkles);
}

// ── 孔明灯：远景缓慢上飘的 12 个暖光 sprite（灯会氛围，开销可忽略）──
let skyLanterns = null;
function createSkyLanterns() {
    if (skyLanterns) return skyLanterns;
    skyLanterns = new THREE.Group();
    const tex = createRadialGlowTexture('rgba(255, 188, 110, 1)', 64);
    for (let i = 0; i < 12; i++) {
        const mat = new THREE.SpriteMaterial({
            map: tex, transparent: true, opacity: 0,
            blending: THREE.AdditiveBlending, depthWrite: false,
        });
        const sprite = new THREE.Sprite(mat);
        const scale = 3.2 + Math.random() * 3.4;
        sprite.scale.set(scale * 0.82, scale, 1); // 略竖长，像远处的孔明灯
        sprite.position.set(
            (Math.random() - 0.5) * 480,
            -20 + Math.random() * 190,
            -110 - Math.random() * 50
        );
        sprite.userData = {
            riseSpeed: 6 + Math.random() * 4,
            swayPhase: Math.random() * Math.PI * 2,
            swayAmp: 3 + Math.random() * 4,
            baseX: sprite.position.x,
            baseOpacity: 0.34 + Math.random() * 0.28,
        };
        sprite.layers.enable(BLOOM_LAYER);
        skyLanterns.add(sprite);
    }
    skyLanterns.visible = false;
    scene.add(skyLanterns);
    return skyLanterns;
}

// ── 群舞水面金碎倒影：碎金光带（横向短笔触纹理 + additive + bloom 层）──
let swarmGlitter = null;
function createSwarmGlitter() {
    if (swarmGlitter) return swarmGlitter;
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    for (let i = 0; i < 110; i++) {
        const y = Math.random() * 64;
        const centerBias = 1 - Math.abs(y - 32) / 32; // 中线附近更密
        if (Math.random() > centerBias * 0.9 + 0.1) continue;
        ctx.fillStyle = `rgba(255, ${190 + Math.floor(Math.random() * 40)}, ${90 + Math.floor(Math.random() * 60)}, ${0.25 + Math.random() * 0.55})`;
        ctx.fillRect(Math.random() * 512, y, 5 + Math.random() * 26, 1 + Math.random() * 2);
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;
    const mat = new THREE.SpriteMaterial({
        map: tex, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false,
    });
    swarmGlitter = new THREE.Sprite(mat);
    swarmGlitter.scale.set(240, 30, 1);
    swarmGlitter.position.set(0, 16, -20); // 抬到巡游灯群正下沿（队列 y≈37-67）
    swarmGlitter.visible = false;
    swarmGlitter.layers.enable(BLOOM_LAYER);
    scene.add(swarmGlitter);
    return swarmGlitter;
}

function updateSwarmGlitter(dt, time, nightActive) {
    if (!LOOK_ENABLED) return;
    const glitter = createSwarmGlitter();
    const active = nightActive && currentPhase === PHASES.LANTERN_SWARM && lanternDanceInstances.length > 0;
    glitter.visible = nightActive && glitter.material.opacity > 0.01;
    const targetOpacity = active ? 0.27 + 0.06 * Math.sin(time * 2.3) : 0;
    glitter.material.opacity += (targetOpacity - glitter.material.opacity) * Math.min(1, dt * 2.0);
    if (!active) return;
    glitter.visible = true;
    // 跟随灯群质心 X，碎金缓慢横漂（像水面波光）
    let cx = 0;
    lanternDanceInstances.forEach((inst) => { cx += inst.mesh.position.x; });
    cx /= lanternDanceInstances.length;
    glitter.position.x += (cx * 0.85 - glitter.position.x) * Math.min(1, dt * 1.2);
    glitter.material.map.offset.x = time * 0.014;
}

function updateSkyLanterns(dt, time, nightActive) {
    if (!LOOK_ENABLED) return;
    const group = createSkyLanterns();
    group.visible = nightActive;
    if (!nightActive) return;
    group.children.forEach((sprite) => {
        const d = sprite.userData;
        sprite.position.y += d.riseSpeed * dt;
        sprite.position.x = d.baseX + Math.sin(time * 0.4 + d.swayPhase) * d.swayAmp;
        if (sprite.position.y > 175) {
            sprite.position.y = -25;
            d.baseX = (Math.random() - 0.5) * 480;
        }
        // 顶部渐隐、整体微闪
        const topFade = THREE.MathUtils.clamp((165 - sprite.position.y) / 30, 0, 1);
        sprite.material.opacity = d.baseOpacity * topFade
            * (0.9 + 0.1 * Math.sin(time * 2.1 + d.swayPhase));
    });
}

function spawnMiniFirework(time, variant = 'mixed', slot = null, originOverride = null) {
    const isYellow = variant === 'yellow';
    const count = isYellow ? 22 + Math.floor(Math.random() * 10) : 34 + Math.floor(Math.random() * 18);
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const velocities = new Float32Array(count * 3);
    const sideBias = slot ?? Math.random();
    const originX = sideBias < 0.34
        ? -150 - Math.random() * 85
        : (sideBias > 0.66 ? 150 + Math.random() * 85 : (Math.random() - 0.5) * 160);
    const origin = originOverride
        ? originOverride.clone().add(new THREE.Vector3(
            (Math.random() - 0.5) * 14, (Math.random() - 0.5) * 10, (Math.random() - 0.5) * 8))
        : new THREE.Vector3(
            originX,
            48 + Math.random() * 86,
            -38 - Math.random() * 75
        );
    const palette = isYellow ? [
        new THREE.Color(0xfff1a8),
        new THREE.Color(0xffd45a),
        new THREE.Color(0xffec7a),
    ] : [
        new THREE.Color(0xffd88a),
        new THREE.Color(0x9bdcff),
        new THREE.Color(0xff9ec7),
        new THREE.Color(0xc7fff1),
    ];
    const baseColor = palette[Math.floor(Math.random() * palette.length)];
    for (let i = 0; i < count; i++) {
        const i3 = i * 3;
        pos[i3] = origin.x;
        pos[i3 + 1] = origin.y;
        pos[i3 + 2] = origin.z;
        const angle = Math.random() * Math.PI * 2;
        const rise = (Math.random() - 0.15) * 0.8;
        const speed = isYellow ? 8 + Math.random() * 15 : 11 + Math.random() * 24;
        velocities[i3] = Math.cos(angle) * speed;
        velocities[i3 + 1] = Math.sin(angle) * speed * 0.62 + rise * 10;
        velocities[i3 + 2] = (Math.random() - 0.5) * speed * 0.42;
        colors[i3] = baseColor.r;
        colors[i3 + 1] = baseColor.g;
        colors[i3 + 2] = baseColor.b;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const mat = new THREE.PointsMaterial({
        size: isYellow ? 2.3 : 3.0,
        vertexColors: true,
        transparent: true,
        opacity: 0.92,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        sizeAttenuation: true,
    });
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    points.userData = { age: 0, life: (isYellow ? 0.95 : 1.15) + Math.random() * 0.35, velocities };
    points.layers.enable(BLOOM_LAYER);
    fireworkBursts.push(points);
    scene.add(points);
}

function updateNightEmbellishments(dt, time) {
    const nightActive = document.body.classList.contains('lantern-night-stage');
    if (nightSparkles?.material) {
        nightSparkles.visible = nightActive;
        nightSparkles.material.opacity += ((nightActive ? 0.95 : 0) - nightSparkles.material.opacity) * Math.min(1, dt * 2.0);
        if (nightActive) {
            const attr = nightSparkles.geometry.attributes.color;
            const colors = attr.array;
            const { baseColors, phases, speeds, warmFlags } = nightSparkles.userData;
            // PHASE_LOOK 驱动的灯会暖化：~70% 火花向暖金 (1.0, 0.78, 0.45) 渐变
            const warmth = lookState.sparkleWarmth;
            for (let i = 0; i < phases.length; i++) {
                const i3 = i * 3;
                const pulse = 0.08 + Math.pow(0.5 + 0.5 * Math.sin(time * speeds[i] + phases[i]), 4.2) * 1.55;
                const w = warmth * (warmFlags ? warmFlags[i] : 0);
                colors[i3] = (baseColors[i3] * (1 - w) + 1.0 * w) * pulse;
                colors[i3 + 1] = (baseColors[i3 + 1] * (1 - w) + 0.78 * w) * pulse;
                colors[i3 + 2] = (baseColors[i3 + 2] * (1 - w) + 0.45 * w) * pulse;
            }
            attr.needsUpdate = true;
        }
        nightSparkles.rotation.z = Math.sin(time * 0.08) * 0.018;
        nightSparkles.rotation.y = Math.sin(time * 0.05) * 0.012;
    }

    // 孔明灯：夜景远空缓慢上飘
    updateSkyLanterns(dt, time, nightActive);

    // 群舞水面碎金光带
    updateSwarmGlitter(dt, time, nightActive);

    const fireworksActive = currentPhase === PHASES.LANTERN_SWARM && lanternDanceReleased && lanternDanceReleaseProgress >= 0.9;
    if (fireworksActive && time > nextFireworkAt) {
        const burstCount = 4 + Math.floor(Math.random() * 3);
        for (let i = 0; i < burstCount; i++) spawnMiniFirework(time);
        const yellowSlots = [0.16, 0.5, 0.84].sort(() => Math.random() - 0.5);
        const yellowCount = 2 + Math.floor(Math.random() * 2);
        for (let i = 0; i < yellowCount; i++) spawnMiniFirework(time, 'yellow', yellowSlots[i]);
        nextFireworkAt = time + 0.65 + Math.random() * 0.85;
    }
    if (!fireworksActive) nextFireworkAt = time + 1.2;

    for (let i = fireworkBursts.length - 1; i >= 0; i--) {
        const burst = fireworkBursts[i];
        const data = burst.userData;
        data.age += dt;
        const positions = burst.geometry.attributes.position.array;
        for (let p = 0; p < positions.length; p += 3) {
            positions[p] += data.velocities[p] * dt;
            positions[p + 1] += data.velocities[p + 1] * dt;
            positions[p + 2] += data.velocities[p + 2] * dt;
            data.velocities[p] *= 0.982;
            data.velocities[p + 1] = data.velocities[p + 1] * 0.982 - 10.5 * dt;
            data.velocities[p + 2] *= 0.982;
        }
        burst.geometry.attributes.position.needsUpdate = true;
        const t = data.age / data.life;
        burst.material.opacity = Math.max(0, 0.9 * (1 - t) * (1 - t));
        burst.scale.setScalar(1 + t * 0.18);
        if (data.age >= data.life) {
            scene.remove(burst);
            burst.geometry.dispose();
            burst.material.dispose();
            fireworkBursts.splice(i, 1);
        }
    }
}

// ═══════════════════════════════════════════════════════
// 形态切换
// ═══════════════════════════════════════════════════════
function switchToStage(targetIdx) {
    if (isMorphing) return;
    hideFinalModel();

    // 切入鱼群模式
    if (targetIdx >= STAGES.length) {
        // 进入鱼群前，显示鱼灯GLB模型作为过渡
        showLanternModel();
        enterBoidsMode();
        currentStage = targetIdx;
        updateUI();
        return;
    }

    // 退出鱼群模式
    if (isBoidsMode) {
        exitBoidsMode();
    }

    if (targetIdx === currentStage && !isBoidsMode) return;

    // 设置 morph: 从当前阶段 → 目标阶段
    const data = fishPointClouds[currentFishIndex];
    if (!data) return;
    const fromKey = currentStage === 0 ? 'fish' : 'lantern';
    const toKey = targetIdx === 0 ? 'fish' : 'lantern';

    isMorphing = true;
    morphProgress = 0;
    uniforms.uPosA.value = data[fromKey].posTex;
    uniforms.uPosB.value = data[toKey].posTex;
    uniforms.uColA.value = data[fromKey].colTex;
    uniforms.uColB.value = data[toKey].colTex;
    uniforms.uMorph.value = 0.0;
    currentStage = targetIdx;

    // TD粒子变形：显示粒子系统，隐藏GLB模型（变形期间用粒子表演）
    if (particleSystem) {
        particleSystem.visible = true;
        particleSystem.position.set(0, 0, 0);
    }
    if (fishMeshGroup) fishMeshGroup.visible = false;
    if (lanternMeshGroup) lanternMeshGroup.visible = false;

    // 背景暗化（让粒子更醒目）
    morphOverlay.style.opacity = '1';

    // 提示
    showToast('✨ 粒子化形中…', CONFIG.morphDuration * 1000);

    resetRitualTimeout();
    updateUI();
}

function enterBoidsMode() {
    enterPhase(PHASES.LANTERN_SWARM);
}

function exitBoidsMode() {
    enterPhase(PHASES.WATER);
}

/**
 * 仪式手势触发：切换到指定stage，或执行放生
 * @param {number|string} target - stage序号(1-4) 或 'release'
 */
function triggerRitualGesture(target) {
    if (target === 'release') {
        playRitualSfx('release');
        resetRitualTimeout();
        ritualCooldown = RITUAL_COOLDOWN;
        enterPhase(PHASES.LANTERN_RECEIVE);
        return;
    }

    // 只允许顺序推进（防止跳跃）
    if (target !== currentStage + 1) return;
    playRitualSfx(target);
    ritualCooldown = RITUAL_COOLDOWN;

    // 视觉反馈：短暂光晕闪烁
    const flash = document.createElement('div');
    flash.style.cssText = `
        position:fixed;inset:0;pointer-events:none;z-index:9999;
        background:radial-gradient(circle, rgba(255,240,200,0.18) 0%, transparent 70%);
        transition: opacity 0.6s ease-out; opacity:1;
    `;
    document.body.appendChild(flash);
    requestAnimationFrame(() => { flash.style.opacity = '0'; });
    setTimeout(() => flash.remove(), 700);

    switchToStage(target);

    const hintEl = document.getElementById('hint-text');
    const stageNames = ['', '骨架已展开', '竹纸已糊上', '色彩已点染', '🏮 鱼灯亮了！'];
    if (hintEl && stageNames[target]) hintEl.textContent = stageNames[target];

    updateGestureProgress(target);
    updateRitualCue(target);
}

let craftVideoFallbackTimer = null;
function cancelCraftVideoFallback() {
    if (craftVideoFallbackTimer) { clearTimeout(craftVideoFallbackTimer); craftVideoFallbackTimer = null; }
}

function enterCraftVideoExperience(forceOpen = false) {
    if (craftVideoOpen) return;
    if (lanternSummonStage !== 'idle') return;
    if (!forceOpen && (currentPhase !== PHASES.CRAFTING || currentStage !== 0)) return;

    craftVideoOpen = true;
    currentStage = 0;
    ritualCooldown = RITUAL_COOLDOWN;
    // 把摄像头让给制灯视频 iframe（单设备无法两路同开），其内部手势识别才能工作
    pauseHandInput();
    spreadGesture.prevDist = 0;
    spreadGesture.accumDelta = 0;
    playRitualSfx(1);

    const flash = document.createElement('div');
    flash.style.cssText = `
        position:fixed;inset:0;pointer-events:none;z-index:11999;
        background:radial-gradient(circle, rgba(255,240,200,0.22) 0%, transparent 70%);
        transition: opacity 0.6s ease-out; opacity:1;
    `;
    document.body.appendChild(flash);
    requestAnimationFrame(() => { flash.style.opacity = '0'; });
    setTimeout(() => flash.remove(), 700);

    const overlay = document.getElementById('craft-video-overlay');
    const frame = document.getElementById('craft-video-frame');
    if (!overlay || !frame) return;

    craftVideoUrl = craftVideoUrl || resolveCraftVideoUrl();
    // iframe 加载失败兜底：避免黑屏卡死（P0）
    frame.onerror = () => {
        console.warn('[WARN] 制灯视频 iframe 加载失败，自动跳过');
        showToast('⚠️ 工艺体验加载失败，已为你跳过', 2600);
        finishCraftVideoAndRevealLantern();
    };
    // 内容淡入：iframe load 后才显示（暗底 overlay 仍即时盖上防闪色）
    if (craftOverlayCloseTimer) { clearTimeout(craftOverlayCloseTimer); craftOverlayCloseTimer = null; }
    overlay.classList.remove('is-fading');
    if (!frame.src || frame.src !== craftVideoUrl) {
        overlay.classList.remove('frame-ready');
        frame.addEventListener('load', () => overlay.classList.add('frame-ready'), { once: true });
        frame.src = craftVideoUrl;
    } else {
        overlay.classList.add('frame-ready');
    }

    document.getElementById('ritual-cue')?.classList.add('is-hidden');
    hideCraftReturnCue();
    overlay.classList.remove('is-hidden');
    overlay.setAttribute('aria-hidden', 'false');
    showToast('🏮 进入非遗鱼灯数字工艺体验 · 四步完成后自动领取鱼灯', 3200);

    cancelCraftVideoFallback();
}

function hideCraftReturnCue() {
    craftAwaitingClapReturn = false;
    document.getElementById('craft-return-cue')?.classList.remove('is-visible');
    clapReturnGesture.lastX = null;
    clapReturnGesture.travel = 0;
    clapReturnGesture.stable = 0;
}

function showCraftReturnCue() {
    craftAwaitingClapReturn = true;
    document.getElementById('craft-return-cue')?.classList.add('is-visible');
}

let craftOverlayCloseTimer = null;
function closeCraftVideoOverlay() {
    craftVideoOpen = false;
    hideCraftReturnCue();
    const overlay = document.getElementById('craft-video-overlay');
    const frame = document.getElementById('craft-video-frame');
    if (overlay && !overlay.classList.contains('is-hidden')) {
        // 0.6s 淡出后再真正隐藏并卸载 iframe（替代原硬切）
        overlay.classList.add('is-fading');
        overlay.setAttribute('aria-hidden', 'true');
        if (craftOverlayCloseTimer) clearTimeout(craftOverlayCloseTimer);
        craftOverlayCloseTimer = setTimeout(() => {
            craftOverlayCloseTimer = null;
            overlay.classList.add('is-hidden');
            overlay.classList.remove('is-fading', 'frame-ready');
            if (frame) frame.src = 'about:blank';
        }, 620);
    } else if (frame) {
        frame.src = 'about:blank';
    }
    // 制灯视频结束/退出，主程序重新接管摄像头（领取鱼灯、升天等阶段的手势需要它）。
    // 稍等 iframe 释放摄像头后再取流，避免 NotReadableError（设备占用）。
    setTimeout(() => resumeHandInput(), 500);
}

function buildPerimeterScatterTexture(sourcePosTex, texSize) {
    const scatter = new Float32Array(texSize * texSize * 4);
    const count = texSize * texSize;
    for (let i = 0; i < count; i++) {
        const si = i * 4;
        const golden = i * 2.399963229728653;
        const ring = 86 + (i % 11) * 5.5 + (i % 7) * 3.2;
        scatter[si] = Math.cos(golden) * ring;
        scatter[si + 1] = ((i % 19) - 9) * 2.4;
        scatter[si + 2] = Math.sin(golden) * ring * 0.75;
        scatter[si + 3] = 1;
    }
    const tex = new THREE.DataTexture(scatter, texSize, texSize, THREE.RGBAFormat, THREE.FloatType);
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.needsUpdate = true;
    return tex;
}

// 夜景背景纹理：bloom 合成会破坏画布透明度（CSS 背景被盖黑），
// 夜景时把同一张 PNG 改为 scene.background 在 WebGL 内绘制（cover 适配）
let nightBgTexture = null;
let nightBgLoading = false;
function fitNightBackgroundCover() {
    const tex = nightBgTexture;
    if (!tex?.image?.width) return;
    const canvasAspect = window.innerWidth / window.innerHeight;
    const imgAspect = tex.image.width / tex.image.height;
    if (canvasAspect > imgAspect) {
        const frac = imgAspect / canvasAspect; // 画布更宽：上下裁切
        tex.repeat.set(1, frac);
        tex.offset.set(0, (1 - frac) / 2);
    } else {
        const frac = canvasAspect / imgAspect; // 画布更窄：左右裁切
        tex.repeat.set(frac, 1);
        tex.offset.set((1 - frac) / 2, 0);
    }
}
function ensureNightBackground() {
    if (nightBgTexture) {
        scene.background = nightBgTexture;
        return;
    }
    if (nightBgLoading) return;
    nightBgLoading = true;
    new THREE.TextureLoader().load('./assets/lantern-night-bg.png', (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        nightBgTexture = tex;
        fitNightBackgroundCover();
        // 异步加载完成时可能已退出夜景
        if (document.body.classList.contains('lantern-night-stage')) {
            scene.background = tex;
        }
    });
}

function setLanternNightMode(enabled) {
    document.body.classList.toggle('lantern-night-stage', enabled);
    // 夜景=画上舞台：锁定相机旋转，否则星空/孔明灯会跟着鼠标在静止的夜空画上滑动
    if (controls) {
        controls.enableRotate = !enabled;
        if (enabled) controls.autoRotate = false;
    }
    if (ambientBackgroundParticles) ambientBackgroundParticles.visible = !enabled;
    if (causticsEffect) causticsEffect.mesh.visible = !enabled;
    // 夜景背景进 WebGL（CSS 背景保留为加载兜底）
    if (LOOK_ENABLED) {
        if (enabled) {
            ensureNightBackground();
            scene.backgroundIntensity = 1.12; // 补偿 ACES 对已授权图像的压暗
        } else {
            scene.background = null;
        }
    }
    if (!enabled) {
        document.getElementById('lantern-summon-ui')?.classList.add('is-hidden');
    }
    // 夜景基调：领灯/群舞走灯会暖金；CRAFTING 中途切夜景也按领灯处理
    if (enabled) {
        applyPhaseLook(currentPhase === PHASES.LANTERN_SWARM ? 'lanternSwarm' : 'lanternReceive');
    } else {
        applyPhaseLook(currentPhase);
    }
}

function updateLanternSummonCopy(title, subtitle) {
    const root = document.getElementById('lantern-summon-ui');
    const titleEl = document.getElementById('lantern-summon-title');
    const subEl = document.getElementById('lantern-summon-sub');
    if (root) root.classList.remove('is-hidden');
    updateLanternNameDisplay();
    if (titleEl) titleEl.textContent = title;
    if (subEl) subEl.textContent = subtitle;
}

function enterLanternSummonWaiting() {
    closeCraftVideoOverlay();
    catchShowcaseActive = false;
    hideFishKnowledgeCard();
    lanternSummonStage = 'waiting';
    currentPhase = PHASES.LANTERN_RECEIVE;
    updatePhaseIndicator();
    currentStage = 1;
    resetRitualTimeout();
    lanternSummonSweep = { lastX: null, travel: 0, stableFrames: 0, lastAt: performance.now() };
    setLanternNightMode(true);
    hideAllFishMeshes();
    hideLanternModel();
    if (particleSystem) particleSystem.visible = false;
    document.getElementById('ritual-cue')?.classList.add('is-hidden');
    const summonBtn = document.getElementById('lantern-summon-btn');
    if (summonBtn) summonBtn.disabled = false;
    updateLanternSummonCopy('左右挥动手掌，召唤你的鱼灯', 'SWEEP YOUR PALM TO SUMMON THE LANTERN');
}

function updateLanternSummonSweep(palmX, isOpenPalm) {
    // 领取鱼灯阶段(stage 'model')与旧的等待态('waiting')都接受「左右挥掌」推进
    const canSweep = lanternSummonStage === 'waiting';
    if (!canSweep || !isOpenPalm) {
        lanternSummonSweep.lastX = palmX;
        lanternSummonSweep.stableFrames = Math.max(0, lanternSummonSweep.stableFrames - 1);
        return;
    }
    const previousX = lanternSummonSweep.lastX;
    lanternSummonSweep.lastX = palmX;
    if (previousX === null) return;
    const dx = Math.abs(palmX - previousX);
    if (dx < 0.004) return;
    lanternSummonSweep.travel += dx;
    lanternSummonSweep.stableFrames++;
    setGestureProgress(Math.min(0.96, lanternSummonSweep.travel / 0.16), '🖐');
    if (lanternSummonSweep.travel >= 0.16 && lanternSummonSweep.stableFrames >= 8) {
        lanternSummonSweep.travel = 0;
        lanternSummonSweep.stableFrames = 0;
        setGestureProgress(0);
        handleSummonLantern();
    }
}

async function handleSummonLantern() {
    if (lanternSummonStage !== 'waiting') return;
    lanternSummonStage = 'particles';
    const summonBtn = document.getElementById('lantern-summon-btn');
    if (summonBtn) summonBtn.disabled = true;
    updateLanternSummonCopy('鱼影化灯，光点成形', 'THE FISH SHADOW BECOMES LIGHT');

    await loadLanternMesh(currentFishIndex);
    const data = fishPointClouds[currentFishIndex];
    if (!data || !particleSystem || !uniforms) {
        showLanternModel();
        return;
    }

    if (lanternRevealScatterTex) lanternRevealScatterTex.dispose();
    lanternRevealScatterTex = buildPerimeterScatterTexture(data.lantern.posTex, CONFIG.texSize);

    currentPhase = PHASES.LANTERN_RECEIVE;
    currentStage = 1;
    lanternRevealActive = true;
    isMorphing = true;
    morphProgress = 0;

    uniforms.uPosA.value = lanternRevealScatterTex;
    uniforms.uPosB.value = data.lantern.posTex;
    uniforms.uColA.value = data.lantern.colTex;
    uniforms.uColB.value = data.lantern.colTex;
    uniforms.uMorph.value = 0;

    particleSystem.visible = true;
    lanternRevealOriginalPointSize = uniforms.uSize.value;
    uniforms.uSize.value = Math.min(0.82, lanternRevealOriginalPointSize);
    particleSystem.position.set(0, 0, 0);
    if (fishMeshGroup) fishMeshGroup.visible = false;
    if (lanternMeshGroup) lanternMeshGroup.visible = false;
    morphOverlay.style.opacity = '1';

    controls.target.set(0, 0, 0);
    controls.autoRotate = false;
    camera.position.set(0, 10, 168);
    controls.update();

    updateGestureProgress(4);
    const info = FISH_KNOWLEDGE[currentFishIndex];
    const fishName = FISH_TYPES[currentFishIndex]?.name || '';
    showToast(`🏮 ${info?.shadowName || fishName} · 粒子正汇聚为鱼灯`, 3200);
    const hintEl = document.getElementById('hint-text');
    if (hintEl) hintEl.textContent = `${fishName}鱼灯成形中 · 四散粒子向心聚拢`;
    document.getElementById('gesture-progress')?.style.setProperty('display', 'flex');
}

function completeLanternRevealModel() {
    lanternOutlineHoldTimer = null;
    lanternRevealActive = false;
    lanternSummonStage = 'model';
    if (particleSystem) particleSystem.visible = false;
    if (lanternRevealOriginalPointSize !== null) {
        uniforms.uSize.value = lanternRevealOriginalPointSize;
        lanternRevealOriginalPointSize = null;
    }
    showLanternModel();
    playRitualSfx(4);
    clearLanternDanceTimers();
    updateLanternSummonCopy('你的鱼灯已生成', 'YOUR FISH LANTERN IS READY');
    const summonBtn = document.getElementById('lantern-summon-btn');
    if (summonBtn) {
        summonBtn.disabled = false;
        summonBtn.querySelector('span').textContent = 'OK 确认领取';
        summonBtn.querySelector('small').textContent = 'CONFIRM TO ENTER LANTERN SWARM';
    }
    const info = FISH_KNOWLEDGE[currentFishIndex];
    const hintEl = document.getElementById('hint-text');
    if (hintEl) hintEl.textContent = `${info?.shadowName || FISH_TYPES[currentFishIndex].name} · 鱼灯已点亮`;
    showToast('鱼灯已生成 · 张开手掌向上可放生', 2800);
}

function finishCraftVideoAndRevealLantern() {
    if (!craftVideoOpen && !craftAwaitingClapReturn) return;
    cancelCraftVideoFallback();
    closeCraftVideoOverlay();   // ★ 关闭叠层并复位 craftVideoOpen，避免残留卡死（P0）
    // 去掉旧的 DataTexture「鱼影化灯」粒子汇聚（与鱼影显形重复、风格不一致）：
    // 直接进入鱼灯领取，鱼灯成品直接显现，再进入升天。
    lanternSummonStage = 'idle';
    enterPhase(PHASES.LANTERN_RECEIVE);
}

function exitCraftVideoExperience() {
    finishCraftVideoAndRevealLantern();
}

function detectClapReturn(hand0) {
    if (!craftVideoOpen || !craftAwaitingClapReturn || !hand0) return;
    const x = hand0[9]?.x ?? hand0[0].x;
    if (clapReturnGesture.lastX === null) {
        clapReturnGesture.lastX = x;
        return;
    }
    const dx = Math.abs(x - clapReturnGesture.lastX);
    clapReturnGesture.lastX = x;
    if (dx < 0.004) {
        clapReturnGesture.stable = Math.max(0, clapReturnGesture.stable - 1);
        return;
    }
    clapReturnGesture.travel += dx;
    clapReturnGesture.stable++;
    if (clapReturnGesture.travel >= 0.16 && clapReturnGesture.stable >= 8) {
        clapReturnGesture.lastX = null;
        clapReturnGesture.travel = 0;
        clapReturnGesture.stable = 0;
        finishCraftVideoAndRevealLantern();
    }
}

function updateGestureProgress(stage) {
    document.querySelectorAll('.gesture-step').forEach((el, i) => {
        el.classList.toggle('done', i <= stage);
    });
}

function updateRitualCue(key, forceShow = true) {
    const cue = RITUAL_CUES[key];
    const root = document.getElementById('ritual-cue');
    if (!root) return;
    if (!loaderReady) {
        root.classList.add('is-hidden');
        return;
    }
    // 无对应cue或不强制显示时隐藏
    if (!cue || !forceShow) {
        root.classList.add('is-hidden');
        return;
    }

    const kicker = document.getElementById('ritual-kicker');
    const title = document.getElementById('ritual-title');
    const subtitle = document.getElementById('ritual-subtitle');
    const leftHand = document.querySelector('#ritual-gesture .hand-left');
    const rightHand = document.querySelector('#ritual-gesture .hand-right');
    if (kicker) kicker.textContent = cue.kicker;
    if (title) title.textContent = cue.title;
    if (subtitle) subtitle.textContent = cue.subtitle;
    if (leftHand) leftHand.textContent = cue.hands?.[0] || '✋';
    if (rightHand) rightHand.textContent = cue.hands?.[1] || '✋';
    root.dataset.cue = String(key);
    root.dataset.gesture = cue.gesture;
    root.classList.remove('is-hidden');
}

// ═══════════════════════════════════════════════════════
// 页面阶段管理
// ═══════════════════════════════════════════════════════
let fishShadowTime = 0;
let fishEmergProgress = 0;
let fishShadowOpacity = 0;   // 水下鱼影透明度
let fishAttracted = false;   // 鱼是否被吸引靠近
let fishAttractionTimer = 0; // 鱼影吸引累计时间
const WAKE_FISH_DURATION = 5;
let wakeFishActive = false;
let wakeFishElapsed = 0;
let waterIdleElapsed = 0; // 水面空闲计时：无人挥手时自动开始（无人值守吸引循环）
let wakeWaveState = { lastX: null, direction: 0, travel: 0, stableFrames: 0, lastRippleAt: 0 };

// 每种鱼型生成多条实例，分散在整个水域。
function buildFishInstanceLayout() {
    const layouts = [];
    const perType = 5;
    const scatter = (n, s) => {
        const v = Math.sin(n * 12.9898 + s * 78.233) * 43758.5453;
        return v - Math.floor(v);
    };
    // 六个松散区域，鱼影在区域内随机偏移，避免排成一行
    const zones = [
        { x: -58, z: -13 }, { x: -28, z: -17 }, { x: 8, z: -10 },
        { x: 38, z: -15 }, { x: 62, z: -11 }, { x: -12, z: -19 },
    ];
    let n = 0;
    for (let type = 0; type < FISH_TYPES.length; type++) {
        for (let k = 0; k < perType; k++) {
            const h1 = scatter(n, 1);
            const h2 = scatter(n, 2);
            const h3 = scatter(n, 3);
            const h4 = scatter(n, 4);
            const h5 = scatter(n, 5);
            const zone = zones[(type * 3 + k * 2) % zones.length];
            layouts.push({
                typeIndex: type,
                x: zone.x + (h1 - 0.5) * 42,
                z: zone.z + (h2 - 0.5) * 12,
                yShadow: -50 + h3 * 18,
                delay: h4 * 2.8,
                emergeDelay: h5 * 2.0,
                emergeDur: 0.7 + h1 * 0.55,
                fadeDur: 0.6 + h2 * 0.5,
                phase: type * 1.4 + k * 0.85 + h3 * 2.2,
                scaleMul: 0.11 + h4 * 0.038,
                rotY: -Math.PI / 2 + (h5 - 0.5) * 0.65,
            });
            n++;
        }
    }
    return layouts;
}
const FISH_INSTANCE_LAYOUT = buildFishInstanceLayout();
const WATER_SEQUENCE = {
    rippleOnly: 5.0,   // 纯涟漪体验
    shadowFade: 6.0,   // 鱼影渐显
    emerge: 5.0,       // 鱼影上浮
};
function waterSequenceEnd() {
    return WATER_SEQUENCE.rippleOnly + WATER_SEQUENCE.shadowFade + WATER_SEQUENCE.emerge;
}

function resetWakeFishStage() {
    wakeFishActive = false;
    wakeFishElapsed = 0;
    wakeWaveState = { lastX: null, direction: 0, travel: 0, stableFrames: 0, lastRippleAt: 0 };
}

function startWakeFishStage() {
    if (wakeFishActive || currentPhase !== PHASES.WATER) return;
    wakeFishActive = true;
    wakeFishElapsed = 0;
    fishAttractionTimer = 0;
    showToast('手掌左右轻摆，鱼影将在 10 秒内逐渐浮现', 1800);
}

function updateWakePalmWave(palmX, palmY, isOpenPalm) {
    if (currentPhase !== PHASES.WATER || !isOpenPalm) {
        wakeWaveState.lastX = palmX;
        wakeWaveState.stableFrames = Math.max(0, wakeWaveState.stableFrames - 1);
        return;
    }

    const previousX = wakeWaveState.lastX;
    wakeWaveState.lastX = palmX;
    if (previousX === null) return;

    const dx = palmX - previousX;
    const absDx = Math.abs(dx);
    if (absDx < 0.004) {
        wakeWaveState.stableFrames = Math.max(0, wakeWaveState.stableFrames - 1);
        return;
    }

    const direction = Math.sign(dx);
    if (wakeWaveState.direction && direction !== wakeWaveState.direction) {
        wakeWaveState.travel *= 0.45;
    }
    wakeWaveState.direction = direction;
    wakeWaveState.travel += absDx;
    wakeWaveState.stableFrames++;

    const now = performance.now();
    if (now - wakeWaveState.lastRippleAt > 150 && waterRipple) {
        waterRipple.addRippleAt(1 - palmX, 1 - palmY);
        wakeWaveState.lastRippleAt = now;
    }

    if (wakeWaveState.travel >= 0.12 && wakeWaveState.stableFrames >= 8) {
        startWakeFishStage();
        wakeWaveState.travel = 0;
        wakeWaveState.stableFrames = 0;
    }
}

function updateWakeFishShadows(progress, time) {
    const opacity = 0.18 + Math.min(1, progress) * 0.78;
    waterFishInstances.forEach((inst) => {
        const spot = inst.layout;
        const yPos = (spot.yShadow ?? -45) + progress * 20;
        styleFishShadow(inst.mesh, opacity, yPos, time, spot, spot.scaleMul);
        if (inst.swimCtrl) {
            inst.swimCtrl.uniforms.uSwimTime.value = time + spot.phase;
            inst.swimCtrl.uniforms.uSwimSpeed.value = 3.4 + (inst.typeIndex % 3) * 0.4;
            inst.swimCtrl.uniforms.uSwimAmp.value = 0.17 + progress * 0.1;
        }
    });
    fishShadowOpacity = opacity;
}

// 钓鱼状态机
const FISH_STATE = { SWIMMING: 0, APPROACHING: 1, BITING: 2, STRUGGLING: 3, CAUGHT: 4 };
let fishingState = FISH_STATE.SWIMMING;
let fishingStateTimer = 0;      // 当前状态持续时间
let fishingApproachDelay = 0;   // 自动靠近鱼钩的等待时间
let fishingStruggleCount = 0;   // 挣扎次数计数
let fishingReelAssist = 0;      // 捏合收线辅助（仅拉锯阶段）
let fishingLineDropped = false;
let fishingPinchCount = 0;
let fishingPinchStableFrames = 0;
let fishingPinchReleaseFrames = 0;
let fishingPinchReleased = true;
let craftFishYaw = -Math.PI / 2;  // 制灯阶段纯 Y 轴展示角
let showcaseSwimYaw = -Math.PI / 2; // 卡片展示鱼的游动航向（起始侧对镜头）
const FISHING_CAM_Z = 160;
const CATCH_FISH_OFFSET = { x: -42, y: 6, z: 0 };
const CATCH_CAM_TARGET = { x: -28, y: 4, z: 0 };

/** 与 FISH_TYPES 索引一一对应 */
const FISH_KNOWLEDGE = [
    { shadowName: '浮金之影', lanternName: '浮金鱼灯', meaning: '非遗新生、年节祝福、灯火流动、水乡丰收' },
    { shadowName: '狮子头鱼之影', lanternName: '狮子头鱼灯', meaning: '节庆、热闹、巡游气氛' },
    { shadowName: '石斑之影', lanternName: '石斑鱼灯', meaning: '富足、地方物产、丰收记忆' },
    { shadowName: '火鲤之影', lanternName: '火鲤鱼灯', meaning: '喜庆、丰收、年节热闹' },
    { shadowName: '鲮鱼之影', lanternName: '鲮鱼鱼灯', meaning: '水乡生活、渔业兴盛、顺德地方记忆' },
    { shadowName: '金鲤之影', lanternName: '金鲤鱼灯', meaning: '金光流转，传递吉祥，工艺永续，繁荣昌盛' },
    { shadowName: '海虾之影', lanternName: '海虾灯', meaning: '红火吉祥、五谷丰登、活力跃动' },
    { shadowName: '螃蟹之影', lanternName: '螃蟹灯', meaning: '喜气洋洋、纵横四海、节庆呈祥' },
];

let catchShowcaseActive = false;
let knowledgePreview = null;

function getCurrentLanternName() {
    const info = FISH_KNOWLEDGE[currentFishIndex];
    if (info?.lanternName) return info.lanternName;
    const path = FISH_TYPES[currentFishIndex]?.lantern || '';
    const file = path.split('/').pop()?.replace(/\.glb$/i, '') || FISH_TYPES[currentFishIndex]?.name || '鱼灯';
    return file.replace(/50000$/i, '');
}

function updateLanternNameDisplay() {
    const nameEl = document.getElementById('lantern-current-name');
    if (nameEl) nameEl.textContent = `当前获得：${getCurrentLanternName()}`;
}

// ── 手势进度环：fraction∈(0,1) 时显示金色填充环，否则隐藏 ──
function setGestureProgress(fraction, icon = '✋') {
    const el = document.getElementById('gesture-ring');
    if (!el) return;
    if (!(fraction > 0.01 && fraction < 1)) {
        el.classList.remove('active');
        return;
    }
    el.classList.add('active');
    const deg = Math.round(fraction * 360);
    el.style.setProperty('--gr-grad',
        `conic-gradient(#ffd45a ${deg}deg, rgba(255,246,216,0.14) ${deg}deg)`);
    const iconEl = el.querySelector('.gr-icon');
    if (iconEl && iconEl.textContent !== icon) iconEl.textContent = icon;
}

// ✌️ 比 yes：粒子页顺序切换溶解特效
const fxCycleGesture = { frames: 0, cooldown: 0 };
function isVSignHand(lm) {
    if (!lm) return false;
    const up = (tip, pip) => lm[tip].y < lm[pip].y - 0.02;
    const curled = (tip, pip) => lm[tip].y > lm[pip].y - 0.005;
    const d = (a, b) => Math.hypot(lm[a].x - lm[b].x, lm[a].y - lm[b].y);
    const palm = d(0, 9) || 0.1;
    // 拇指必须远离食指尖（排除 OK 的圈型被误判成 V）
    return up(8, 6) && up(12, 10) && curled(16, 14) && curled(20, 18)
        && d(4, 8) > palm * 0.5;
}

function updateFxCycleGesture(isV) {
    if (fxCycleGesture.cooldown > 0) fxCycleGesture.cooldown--;
    if (!particleSceneActive) {
        if (fxCycleGesture.frames > 0) {
            fxCycleGesture.frames = 0;
            setGestureProgress(0);
        }
        return;
    }
    if (!isV) {
        if (fxCycleGesture.frames > 0) {
            fxCycleGesture.frames = Math.max(0, fxCycleGesture.frames - 2);
            setGestureProgress(fxCycleGesture.frames / 10, '✌️');
        }
        return;
    }
    fxCycleGesture.frames++;
    setGestureProgress(fxCycleGesture.frames / 10, '✌️');
    if (fxCycleGesture.frames < 10 || fxCycleGesture.cooldown > 0) return;
    fxCycleGesture.frames = 0;
    fxCycleGesture.cooldown = 45;
    setGestureProgress(0);
    revealFxMode = (revealFxMode + 1) % 5;
    if (particleScene) particleScene.setFxMode(revealFxMode);
    syncRevealPanel();
    revealIdle = 0;
    showToast(`✨ 粒子特效：${['标准','爆炸','漩涡','萤火','星尘'][revealFxMode]}`, 1500);
}

function isOkConfirmHand(landmarks) {
    if (!landmarks) return false;
    const dist3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0));
    const palm = dist3(landmarks[0], landmarks[9]) || 0.1;
    const okDist = dist3(landmarks[4], landmarks[8]);
    const middleOpen = dist3(landmarks[12], landmarks[9]) > palm * 0.62 || landmarks[12].y < landmarks[10].y;
    const ringOpen = dist3(landmarks[16], landmarks[13]) > palm * 0.45 || landmarks[16].y < landmarks[14].y;
    const pinkyOpen = dist3(landmarks[20], landmarks[17]) > palm * 0.42 || landmarks[20].y < landmarks[18].y;
    // 食指若竖直伸出（V 手势特征）则不算 OK——双向互斥
    const indexStraightUp = landmarks[8].y < landmarks[6].y - 0.03;
    return okDist < Math.max(0.065, palm * 0.42) && middleOpen && ringOpen && pinkyOpen
        && !indexStraightUp;
}

function updateOkConfirmGesture(isOk) {
    if (okConfirmGesture.cooldown > 0) okConfirmGesture.cooldown--;
    // 进度环只在「真正等 OK 手势」的四个节点显示
    const okEligible = (currentPhase === PHASES.FISHING && catchShowcaseActive)
        || (currentPhase === PHASES.LANTERN_RECEIVE && lanternSummonStage === 'model')
        || (currentPhase === PHASES.LANTERN_RECEIVE && lanternSummonStage === 'particles')
        || (currentPhase === PHASES.LANTERN_SWARM && lanternDanceReleaseProgress >= 1);
    // 离开 OK 节点时立刻清环（否则 OK 重开回水面后进度环冻在屏上）
    if (!okEligible) {
        if (okConfirmGesture.frames > 0) {
            okConfirmGesture.frames = 0;
            setGestureProgress(0);
        }
        return;
    }
    if (!isOk) {
        if (okConfirmGesture.frames > 0) {
            okConfirmGesture.frames = Math.max(0, okConfirmGesture.frames - 2);
            if (okEligible) setGestureProgress(okConfirmGesture.frames / 12, '👌');
        }
        return;
    }
    okConfirmGesture.frames++;
    if (okEligible) setGestureProgress(okConfirmGesture.frames / 12, '👌');
    // 12 帧（约 0.4s 持续比出 OK）才触发——降低钓鱼捏合余势误触跳过卡片的概率
    if (okConfirmGesture.frames < 12 || okConfirmGesture.cooldown > 0) return;
    okConfirmGesture.frames = 0;
    setGestureProgress(0);
    okConfirmGesture.cooldown = 45;
    if (currentPhase === PHASES.FISHING && catchShowcaseActive) {
        beginCraftFromCatch();
    } else if (currentPhase === PHASES.LANTERN_RECEIVE && lanternSummonStage === 'particles') {
        completeLanternParticleReceive(); // 化光环节比 OK → 凝成鱼灯
    } else if (currentPhase === PHASES.LANTERN_RECEIVE && lanternSummonStage === 'model') {
        enterLanternDance();
    } else if (currentPhase === PHASES.LANTERN_SWARM && lanternDanceReleaseProgress >= 1) {
        // 巡游尾声：比 OK 回到水面（墨晕转场，结尾→开头）
        hideFinalModel();
        currentStage = 0;
        applyFishTextures(currentFishIndex, 0);
        transitionToPhase(PHASES.WATER);
    }
}

// ── 粒子场景：实体鱼灯 ⇄ 粒子鱼影 溶解互动（来自 pointcloud-demo，已模块化） ──
async function activateParticleScene() {
    const layer = document.getElementById('particle-layer');
    if (!layer) return;
    const url = CRAFT_INDEX_TO_PARTICLE[currentFishIndex] || CRAFT_INDEX_TO_PARTICLE[0];
    layer.classList.add('active');
    particleSceneActive = true;
    particleAutoDemoIdle = 0;
    // 粒子全屏期间收掉与之无关的 UI（标题/阶段圆点/仪式提示），避免重叠穿帮
    document.body.classList.add('particle-overlay-active');
    try {
        const inLanternReceive = document.body.classList.contains('lantern-night-stage');
        if (!particleScene) {
            particleScene = new ParticleScene(layer, {
                viewShiftFrac: inLanternReceive ? 0 : 0.2,
                transparentBg: false,
                saturation: 1.5, // 默认 50% 分位（0.5~2.5 的中值）
                exposure: inLanternReceive ? 0.9 : 1.7,
                lightScale: inLanternReceive ? 0.45 : 1.0, // 化光页=「未点亮」素灯（点亮仪式在收灯后）
                // 两个粒子页统一工艺页同款墨绿黑底（bloom 会破坏透明度，背景在 WebGL 内绘制）
                bgStyle: 'craft',
            });
        }
        await particleScene.init();
        await particleScene.loadModel(url);
        // 默认呈现明亮的实体鱼（贴图+灯光，较亮）；张开手掌或拖滑块即化作粒子光点
        particleScene.setFxMode(revealFxMode);
        particleScene.setDissolve(0);
        syncRevealPanel();
        console.log('[INFO] 粒子场景已激活:', url);
    } catch (e) {
        console.warn('[WARN] 粒子场景加载失败:', e);
        deactivateParticleScene();
    }
}

let revealFxMode = 0;
// 同步底部粒子面板 UI（FX 高亮 + 溶解滑块）到当前粒子场景状态
function syncRevealPanel() {
    document.querySelectorAll('#reveal-panel .rp-fx button').forEach((b) => {
        b.classList.toggle('active', parseInt(b.dataset.fx) === revealFxMode);
    });
    const sl = document.getElementById('rp-dissolve');
    if (sl && particleScene) sl.value = String(particleScene.dissolveValue ?? 0.5);
}

function deactivateParticleScene() {
    particleSceneActive = false;
    document.body.classList.remove('particle-receive-stage');
    document.body.classList.remove('particle-overlay-active');
    const layer = document.getElementById('particle-layer');
    if (layer) layer.classList.remove('active');
    if (particleScene) { particleScene.dispose(); particleScene = null; } // 释放显存 (B5)
}

// 「鱼影显形」推进：点「开始制灯」按钮，或无人值守空闲超时（有手交互时清零，绝不打断体验）
let revealIdle = 0;
let particleAutoDemoIdle = 0; // 粒子环节无人自动演示计时
const REVEAL_IDLE_AUTO_S = 12; // 无人交互的自动跳转兜底；给足知识卡片阅读时间（原 5s 读不完文案）
function scheduleRevealAutoAdvance() { revealIdle = 0; }
function cancelRevealAutoAdvance() { revealIdle = 0; }

// 墨晕转场包装：覆墨(0.4s) → enterPhase → 揭墨(0.72s)。
// 仅用于观众可见的阶段切换；开发快捷键仍直接 enterPhase。
let phaseTransitionBusy = false;
let phaseTransitionTarget = null;
function transitionToPhase(phase) {
    const el = document.getElementById('fx-ink-transition');
    if (!LOOK_ENABLED || !el) {
        enterPhase(phase);
        return;
    }
    if (phaseTransitionBusy) {
        // 转场中重复请求同一目标（如每帧触发的自动推进）直接忽略；不同目标则直切兜底
        if (phaseTransitionTarget !== phase) enterPhase(phase);
        return;
    }
    phaseTransitionBusy = true;
    phaseTransitionTarget = phase;
    const night = phase === PHASES.LANTERN_RECEIVE || phase === PHASES.LANTERN_SWARM;
    el.classList.toggle('night-tone', night);
    el.classList.remove('reveal');
    el.classList.add('cover');
    setTimeout(() => {
        enterPhase(phase);
        el.classList.remove('cover');
        el.classList.add('reveal');
        setTimeout(() => {
            el.classList.remove('reveal');
            phaseTransitionBusy = false;
            phaseTransitionTarget = null;
        }, 740);
    }, 410);
}

function enterPhase(phase) {
    currentPhase = phase;
    phaseTransitioning = true;
    applyPhaseLook(phase);
    setGestureProgress(0); // 阶段切换统一清掉手势进度环
    // 切到非工艺阶段时强制收掉工艺 iframe，否则跳阶段后整屏被工艺页盖住（穿帮）
    if (craftVideoOpen && phase !== PHASES.CRAFTING) closeCraftVideoOverlay();
    hideShowcaseShadowFish();

    // 粒子「鱼影显形」环节在 startCatchShowcase 中激活；进入任何正式阶段都先释放，避免叠加冲突
    if (particleSceneActive) deactivateParticleScene();
    cancelRevealAutoAdvance();
    hideFishKnowledgeCard(); // 统一收起知识卡片，避免跳阶段后残留（P1）
    if (phase !== PHASES.CRAFTING) {
        clearLanternDanceTimers();
        clearLanternDanceGroup();
    }
    if (phase !== PHASES.CRAFTING || lanternSummonStage === 'idle') {
        setLanternNightMode(false);
    }
    const useWatercolorBackground = phase === PHASES.WATER || phase === PHASES.FISHING;
    document.body.classList.toggle('intro-water-stages', useWatercolorBackground);
    waterRipple?.setWatercolorMode(useWatercolorBackground);
    if (ambientBackgroundParticles) ambientBackgroundParticles.visible = !useWatercolorBackground;
    if (causticsEffect) causticsEffect.mesh.visible = !useWatercolorBackground;
    playPhaseSfx(phase);
    if (phase === PHASES.CRAFTING || phase === PHASES.LANTERN_RECEIVE || phase === PHASES.LANTERN_SWARM) resetRitualTimeout();
    hideFinalModel();
    
    // 统一隐藏所有 GLB，各阶段按需重新显示
    hideAllFishMeshes();
    if (lanternMeshGroup) lanternMeshGroup.visible = false;
    if (fishSchool) { scene.remove(fishSchool.container); fishSchool = null; }
    if (fishingLine) { scene.remove(fishingLine); fishingLine = null; }
    
    const hintEl = document.getElementById('hint-text');
    const panelBody = document.getElementById('panel-body');
    
    switch (phase) {
        case PHASES.WATER:
            // 水面阶段：隐藏鱼和鱼群，只有水波纹，偶有鱼影
            void setBgmTrack('waves', { restart: true });
            if (particleSystem) particleSystem.visible = false;
            if (fishMeshGroup) fishMeshGroup.visible = false;
            if (lanternMeshGroup) lanternMeshGroup.visible = false;
            if (boidsGroup) boidsGroup.visible = false;
            if (fishSchool) { scene.remove(fishSchool.container); fishSchool = null; }
            if (fishingLine) { scene.remove(fishingLine); fishingLine = null; }
            if (hintEl) hintEl.textContent = '单击或轻触水面制造涟漪';
            updateRitualCue('water');
            controls.autoRotate = false;
            fishShadowOpacity = 0;
            fishEmergProgress = 0;
            fishAttracted = false;
            fishAttractionTimer = 0;
            waterIdleElapsed = 0;
            resetWakeFishStage();
            resetFishMeshMaterials();
            hideAllFishMeshes();
            bgFishDartCtrls = [];
            setFishingBodyFx(null);
            break;
            
        case PHASES.FISHING:
            resetWakeFishStage();
            catchShowcaseActive = false;
            hideFishKnowledgeCard();
            controls.target.set(0, 0, 0);
            resetFishMeshMaterials();
            pickRandomCatchFish();
            initBackgroundFishControllers();
            if (particleSystem) particleSystem.visible = false;
            if (lanternMeshGroup) lanternMeshGroup.visible = false;
            if (fishSchool) { scene.remove(fishSchool.container); fishSchool = null; }
            allFishMeshes.forEach((mesh) => { mesh.visible = false; });
            waterFishInstances.forEach((inst) => {
                inst.mesh.visible = true;
                resetSingleFishMaterial(inst.mesh);
            });
            if (fishMeshGroup && targetFishInstance) {
                fishMeshGroup.rotation.set(0, -Math.PI / 2, 0);
                const baseScale = fishMeshGroup.userData._originalScale || fishMeshGroup.scale.x;
                fishMeshGroup.userData._originalScale = baseScale;
                fishMeshGroup.scale.setScalar(baseScale * 0.3);
            }
            fishDartCtrl = new FishDartController({ x: 55, y: 35 });
            if (targetFishInstance) {
                const spot = targetFishInstance.layout;
                fishDartCtrl.pos.set(spot.x, -8, spot.z);
            }
            fishMeshSwimTime = 0;
            if (boidsGroup) boidsGroup.visible = false;
            fishEmergProgress = 0;
            fishAttracted = false;
            // 初始化钓鱼状态机
            fishingState = FISH_STATE.SWIMMING;
            fishingStateTimer = 0;
            fishingReelAssist = 0;
            fishingLineDropped = false;
            fishingPinchCount = 0;
            fishingPinchStableFrames = 0;
            fishingPinchReleaseFrames = 0;
            fishingPinchReleased = true;
            fishingApproachDelay = 2 + Math.random() * 3; // 2~5秒后鱼开始靠近鱼钩
            fishingStruggleCount = 0;
            setFishingBodyFx(null);
            fishingStruggleCount = 0;
            
            // ── Arduino 钓竿交互初始化 ──────────────────────────────
            showFishingRodPanel();
            rodTension = 0;
            rodFishingState = 'idle';  // 使用字符串状态
            rodFishingStartTime = 0;
            rodFishingSuccessWindow = [30, 70];  // 成功范围：30-70%
            rodLineLength = 100;
            rodTugStrength = 0;
            rodHoldStart = 0;
            rodLastTension = 0;
            rodRawValue = 0;
            rodTargetDirection = 0;
            rodTargetValue = 0;
            rodZeroAdvanceReadyAt = 0;
            rodZeroAdvanceDone = false;
            updateTensionUI(0);  // 重置UI
            
            if (!fishingRodConnected) {
                showToast('💡 点击右上角「连接钓竿」开始钓鱼交互');
                updateTensionUI(0);
            } else {
                showToast('🎣 旋转编码器调整钓线，按钮尝试钓起鱼儿');
            }
            
            if (hintEl) hintEl.textContent = '旋转编码器调节钓线，按钮尝试钓起';
            updateRitualCue('fishing');
            updateFishingCueStep(0);
            syncFishingInputUI();
            controls.autoRotate = false;
            controls.target.set(0, 0, 0);
            // 正面侧视：相机在正前方看鱼的侧面
            camera.position.set(0, 0, 160);
            controls.update();
            break;
            
        case PHASES.CRAFTING:
            // 制灯阶段直接打开黑色四步粒子工艺，不再显示旧蓝底活鱼预览。
            pendingCraftVideoOpen = true;
            if (particleSystem) particleSystem.visible = false;
            if (fishingLine) { scene.remove(fishingLine); fishingLine = null; }
            document.body.classList.remove('fishing-struggle', 'fishing-tension');
            if (fishSchool) { scene.remove(fishSchool.container); fishSchool = null; }
            hideAllFishMeshes();
            if (boidsGroup) boidsGroup.visible = false;
            isBoidsMode = false;
            if (hintEl) hintEl.textContent = '进入黑色粒子工艺体验';
            document.getElementById('ritual-cue')?.classList.add('is-hidden');
            controls.autoRotate = false;
            controls.autoRotateSpeed = 0;
            { const gp = document.getElementById('gesture-progress'); if (gp) gp.style.display = 'flex'; }
            updateGestureProgress(0);
            break;
            
        case PHASES.LANTERN_RECEIVE:
            showLanternReceivePreview();
            break;

        case PHASES.LANTERN_SWARM:
            showLanternSwarmPreview();
            break;
    }
    
    updatePhaseIndicator();
    setTimeout(() => {
        phaseTransitioning = false;
        if (pendingCraftVideoOpen && currentPhase === PHASES.CRAFTING) {
            pendingCraftVideoOpen = false;
            enterCraftVideoExperience(true);
        }
    }, 500);
}

function updatePhaseIndicator() {
    const phases = [PHASES.WATER, PHASES.FISHING, PHASES.CRAFTING, PHASES.LANTERN_RECEIVE, PHASES.LANTERN_SWARM];
    const idx = phases.indexOf(currentPhase);
    document.querySelectorAll('.dot').forEach((dot, i) => {
        dot.classList.toggle('active', i === idx);
    });
}

function advancePhase() {
    if (phaseTransitioning) return;

    switch (currentPhase) {
        case PHASES.WATER:
            enterPhase(PHASES.FISHING);
            break;
        case PHASES.FISHING:
            // 禁止手势/按键跳过：必须走完咬钩→挣扎→收线
            if (fishingState < FISH_STATE.CAUGHT) {
                showToast('🎣 请等待鱼咬钩并完成拉锯…', 1600);
                return;
            }
            enterPhase(PHASES.CRAFTING);
            break;
        case PHASES.CRAFTING:
            enterPhase(PHASES.LANTERN_RECEIVE);
            break;
        case PHASES.LANTERN_RECEIVE:
            enterPhase(PHASES.LANTERN_SWARM);
            break;
        case PHASES.LANTERN_SWARM:
            hideFinalModel();
            currentStage = 0;
            applyFishTextures(currentFishIndex, 0);
            transitionToPhase(PHASES.WATER);
            break;
    }
}

// ═══════════════════════════════════════════════════════
// 手部触控视觉（发光圆点，替代骨架线）
// ═══════════════════════════════════════════════════════
const HAND_GLOW_TIPS = [4, 8, 12, 16, 20];

function drawHandGlow(ctx, landmarks, w, h) {
    const getPos = (lm) => ({
        x: (1.0 - lm.x) * w,
        y: lm.y * h,
    });

    for (const idx of HAND_GLOW_TIPS) {
        const p = getPos(landmarks[idx]);
        const outerR = 10;
        const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, outerR);
        grad.addColorStop(0, 'rgba(255, 255, 255, 0.95)');
        grad.addColorStop(0.35, 'rgba(255, 255, 255, 0.35)');
        grad.addColorStop(1, 'rgba(255, 255, 255, 0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(p.x, p.y, outerR, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
        ctx.fill();
    }

    // 掌心柔光
    const palm = getPos(landmarks[9]);
    const palmGrad = ctx.createRadialGradient(palm.x, palm.y, 0, palm.x, palm.y, 18);
    palmGrad.addColorStop(0, 'rgba(255, 255, 255, 0.18)');
    palmGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = palmGrad;
    ctx.beginPath();
    ctx.arc(palm.x, palm.y, 18, 0, Math.PI * 2);
    ctx.fill();
}

function pickRandomCatchFish() {
    if (!waterFishInstances.length) return;
    targetFishInstance = waterFishInstances[Math.floor(Math.random() * waterFishInstances.length)];
    currentFishIndex = targetFishInstance.typeIndex;
    waterFishInstances.forEach((inst) => { inst.isTarget = inst === targetFishInstance; });
    fishMeshGroup = targetFishInstance.mesh;
    fishSwimCtrl = targetFishInstance.swimCtrl;
    console.log(`[INFO] 本次随机目标: ${FISH_TYPES[currentFishIndex].name}（${waterFishInstances.length}条鱼影中的1条）`);
}

function hideAllFishMeshes() {
    allFishMeshes.forEach((mesh) => { mesh.visible = false; });
    waterFishInstances.forEach((inst) => { inst.mesh.visible = false; });
}

function resetFishMeshMaterials() {
    allFishMeshes.forEach((mesh) => resetSingleFishMaterial(mesh));
    waterFishInstances.forEach((inst) => resetSingleFishMaterial(inst.mesh));
}

function resetSingleFishMaterial(mesh) {
    mesh.traverse((child) => {
        if (!child.isMesh || !child.material) return;
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        mats.forEach((mat) => {
            mat.transparent = false;
            mat.opacity = 1;
            mat.depthWrite = true;
            if (mat.userData._baseColor) mat.color.copy(mat.userData._baseColor);
            if (mat.emissive) mat.emissiveIntensity = 0; // 清掉游动期鳞光残值
        });
    });
}

function applyFishShadowMaterial(mesh, opacity, scaleMul = 0.22) {
    if (!mesh.userData._originalScale) mesh.userData._originalScale = mesh.scale.x;
    mesh.scale.setScalar(mesh.userData._originalScale * scaleMul);
    mesh.traverse((child) => {
        if (!child.isMesh || !child.material) return;
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        mats.forEach((mat) => {
            if (!mat.userData._baseColor) mat.userData._baseColor = mat.color.clone();
            mat.transparent = true;
            mat.depthWrite = false;
            mat.opacity = opacity;
            mat.color.copy(mat.userData._baseColor).multiplyScalar(0.16 + opacity * 0.42);
        });
    });
}

function styleFishShadow(mesh, opacity, yPos, time, spot, scaleMul = 0.18) {
    mesh.visible = opacity > 0.03;
    if (!mesh.visible) return;
    const wobbleX = Math.sin(time * 0.45 + spot.phase) * 4;
    const wobbleZ = Math.cos(time * 0.38 + spot.phase * 1.3) * 3.5;
    mesh.position.set(spot.x + wobbleX, yPos, spot.z + wobbleZ);
    mesh.rotation.set(0, spot.rotY ?? -Math.PI / 2, 0);
    applyFishShadowMaterial(mesh, opacity, scaleMul);
}

function updateAllWaterFishShadows(t, time) {
    const shadowStart = WATER_SEQUENCE.rippleOnly;
    const shadowEnd = shadowStart + WATER_SEQUENCE.shadowFade;
    let maxOpacity = 0;

    waterFishInstances.forEach((inst) => {
        const spot = inst.layout;
        let opacity = 0;
        let yPos = spot.yShadow ?? -45;

        if (t >= shadowStart) {
            const appearT = Math.max(0, t - shadowStart - spot.delay);
            const fadeP = Math.min(1, appearT / (WATER_SEQUENCE.shadowFade * (spot.fadeDur ?? 0.85)));
            opacity = fadeP * 0.38;
            yPos = (spot.yShadow ?? -45) + fadeP * 5;
        }
        if (t >= shadowEnd) {
            const emergeT = Math.max(0, t - shadowEnd - (spot.emergeDelay ?? 0));
            const emergeP = Math.min(1, emergeT / (WATER_SEQUENCE.emerge * (spot.emergeDur ?? 1)));
            opacity = 0.38 + emergeP * 0.32;
            yPos = (spot.yShadow ?? -45) + 5 + emergeP * (22 + (spot.phase % 3) * 4);
        }

        maxOpacity = Math.max(maxOpacity, opacity);
        styleFishShadow(inst.mesh, opacity, yPos, time, spot, spot.scaleMul);

        if (inst.swimCtrl) {
            inst.swimCtrl.uniforms.uSwimTime.value = time + spot.phase;
            inst.swimCtrl.uniforms.uSwimSpeed.value = 3.0 + (inst.typeIndex % 3) * 0.3;
            inst.swimCtrl.uniforms.uSwimAmp.value = 0.15 + opacity * 0.1;
        }
    });
    fishShadowOpacity = maxOpacity;
}

function initBackgroundFishControllers() {
    bgFishDartCtrls = waterFishInstances.map((inst) => {
        if (inst.isTarget) return null;
        const spot = inst.layout;
        const ctrl = new FishDartController({ x: 90, y: 55 });
        ctrl.pos.set(spot.x, -14 + (inst.typeIndex % 4) * 3, spot.z);
        return ctrl;
    });
}

function updateBackgroundFish(dt, time) {
    waterFishInstances.forEach((inst, i) => {
        if (inst.isTarget) return;
        const ctrl = bgFishDartCtrls[i];
        if (!ctrl) return;
        ctrl.update(dt);
        inst.mesh.visible = true;
        inst.mesh.position.copy(ctrl.pos);
        inst.mesh.quaternion.copy(ctrl.quaternion);
        applyFishShadowMaterial(inst.mesh, 0.26 + (inst.typeIndex % 3) * 0.02, inst.layout.scaleMul * 0.92);
        if (inst.swimCtrl) {
            inst.swimCtrl.uniforms.uSwimTime.value = time + inst.layout.phase;
            inst.swimCtrl.uniforms.uSwimSpeed.value = 3.6 + (i % 5) * 0.2;
            inst.swimCtrl.uniforms.uSwimAmp.value = 0.15;
        }
    });
}

function hideNonTargetFish() {
    waterFishInstances.forEach((inst) => {
        if (!inst.isTarget) inst.mesh.visible = false;
    });
}

function ensureKnowledgePreview() {
    if (knowledgePreview) return knowledgePreview;
    const container = document.getElementById('knowledge-fish-canvas');
    if (!container) return null;

    const w = Math.max(container.clientWidth, 280);
    const h = Math.max(container.clientHeight, 180);
    const prevScene = new THREE.Scene();
    prevScene.add(new THREE.HemisphereLight(0xfff4e0, 0x3a2a18, 1.1));
    const key = new THREE.DirectionalLight(0xffe8b8, 1.4);
    key.position.set(40, 60, 80);
    prevScene.add(key);
    const fill = new THREE.DirectionalLight(0xb9ebee, 0.75);
    fill.position.set(-55, 18, 45);
    prevScene.add(fill);
    const rim = new THREE.DirectionalLight(0xffcf87, 1.05);
    rim.position.set(-35, 40, -65);
    prevScene.add(rim);

    const prevCam = new THREE.PerspectiveCamera(32, w / h, 0.1, 500);
    prevCam.position.set(0, 8, 118);
    const prevRenderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    prevRenderer.setSize(w, h);
    prevRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    prevRenderer.outputColorSpace = THREE.SRGBColorSpace;
    prevRenderer.toneMapping = THREE.ACESFilmicToneMapping;
    prevRenderer.toneMappingExposure = 1.08;
    container.appendChild(prevRenderer.domElement);

    const group = new THREE.Group();
    prevScene.add(group);
    knowledgePreview = { scene: prevScene, camera: prevCam, renderer: prevRenderer, group, yaw: -Math.PI / 2 };
    return knowledgePreview;
}

async function updateKnowledgeFishPreview(fishIndex) {
    const kp = ensureKnowledgePreview();
    if (!kp) return;
    while (kp.group.children.length) kp.group.remove(kp.group.children[0]);
    try {
        const mesh = await loadGLBMesh(FISH_TYPES[fishIndex].fish, 66);
        mesh.rotation.set(0, kp.yaw, 0);
        mesh.traverse((obj) => {
            if (!obj.isMesh || !obj.material) return;
            obj.material = obj.material.clone();
            if (obj.material.emissive) {
                obj.material.emissive.setRGB(0.18, 0.11, 0.045);
                obj.material.emissiveIntensity = 0.12;
            }
            if ('roughness' in obj.material) obj.material.roughness = Math.min(obj.material.roughness, 0.72);
        });
        kp.group.add(mesh);
        kp.mesh = mesh;
    } catch (err) {
        console.warn('[WARN] 知识卡片模型加载失败', err);
    }
}

function showFishKnowledgeCard(fishIndex) {
    const info = FISH_KNOWLEDGE[fishIndex];
    const card = document.getElementById('fish-knowledge-card');
    if (!info || !card) return;

    const titleEl = document.getElementById('fkc-title');
    const meaningEl = document.getElementById('fkc-meaning');
    const transitionEl = card.querySelector('.fkc-transition');
    const transitionEnEl = card.querySelector('.fkc-transition-en');
    const enterBtn = document.getElementById('fkc-enter-craft');
    const enterBtnText = enterBtn?.querySelector('span');
    const enterBtnSub = enterBtn?.querySelector('small');
    if (titleEl) titleEl.textContent = `你钓起了「${info.shadowName}」`;
    if (meaningEl) meaningEl.textContent = info.meaning;
    if (fishingRodConnected) {
        if (transitionEl) transitionEl.textContent = '鱼影已上岸，按下鱼竿按钮，进入制灯工艺。';
        if (transitionEnEl) transitionEnEl.textContent = 'PRESS THE FISHING ROD BUTTON TO BEGIN CRAFTING.';
        if (enterBtnText) enterBtnText.textContent = '开始制灯';
        if (enterBtnSub) enterBtnSub.textContent = 'START CRAFTING';
    } else {
        if (transitionEl) transitionEl.textContent = '鱼影已上岸，读完卡片后比出 OK，进入制灯工艺。';
        if (transitionEnEl) transitionEnEl.textContent = 'WHEN READY, MAKE AN OK GESTURE TO BEGIN CRAFTING.';
        if (enterBtnText) enterBtnText.textContent = '开始制灯';
        if (enterBtnSub) enterBtnSub.textContent = 'START CRAFTING';
    }

    updateKnowledgeFishPreview(fishIndex);
    card.classList.remove('is-hidden');
    card.classList.add('is-visible');
    card.setAttribute('aria-hidden', 'false');
    document.body.classList.add('catch-showcase');
    void setBgmTrack('deepsea', { restart: true });
}

function hideFishKnowledgeCard() {
    const card = document.getElementById('fish-knowledge-card');
    if (card) {
        card.classList.add('is-hidden');
        card.classList.remove('is-visible');
        card.setAttribute('aria-hidden', 'true');
    }
    document.body.classList.remove('catch-showcase');
}

// ── 卡片展示的远景鱼影：3 条半透明小鱼在主角身后缓游（常驻复用，避免重复克隆累积 rig）──
let showcaseShadowFish = [];
function ensureShowcaseShadowFish() {
    if (showcaseShadowFish.length) {
        showcaseShadowFish.forEach((f) => { f.mesh.visible = true; });
        return;
    }
    [1, 4, 6].forEach((tplIdx, k) => {
        const tpl = allFishMeshes[tplIdx % allFishMeshes.length];
        if (!tpl) return;
        const m = SkeletonUtils.clone(tpl);
        m.traverse((o) => {
            if (!o.isMesh || !o.material) return;
            o.material = Array.isArray(o.material)
                ? o.material.map((x) => x.clone())
                : o.material.clone();
            const ms = Array.isArray(o.material) ? o.material : [o.material];
            ms.forEach((mm) => {
                mm.transparent = true;
                mm.opacity = 0.3;
                mm.depthWrite = false;
            });
        });
        m.scale.multiplyScalar(0.42 + k * 0.1);
        m.visible = true;
        scene.add(m);
        showcaseShadowFish.push({
            mesh: m,
            rig: attachSpineRig(m, { speed: 2.8 + k * 0.4, amplitude: 0.15, frequency: 1.4, style: 'fish' }),
            phase: k * 2.3,
            speedMul: 0.65 + k * 0.22,
            depth: -46 - k * 14,
            yBase: CATCH_FISH_OFFSET.y + 8 - k * 9,
            yaw: -Math.PI / 2,
        });
    });
}
function hideShowcaseShadowFish() {
    showcaseShadowFish.forEach((f) => { f.mesh.visible = false; });
}
function updateShowcaseShadowFish(dt, time) {
    showcaseShadowFish.forEach((f, k) => {
        if (!f.mesh.visible) return;
        const st = time * 0.2 * f.speedMul + f.phase;
        const px = Math.min(-66 + Math.cos(st) * 58 + Math.sin(st * 0.41 + k) * 18, -22);
        const py = f.yBase + Math.sin(st * 1.3) * 6;
        const pz = f.depth + Math.sin(st * 0.7) * 9;
        const prevX = f.mesh.position.x;
        const prevZ = f.mesh.position.z;
        f.mesh.position.set(px, py, pz);
        const mvX = px - prevX;
        const mvZ = pz - prevZ;
        if (mvX * mvX + mvZ * mvZ > 1e-7) {
            const desired = Math.atan2(mvX, mvZ);
            let dyaw = desired - f.yaw;
            dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
            f.yaw += dyaw * Math.min(1, dt * 2.2);
        }
        f.mesh.rotation.set(0, f.yaw, 0);
        f.rig.uniforms.uSwimTime.value = time + f.phase;
    });
}

function startCatchShowcase() {
    if (catchShowcaseActive || !fishMeshGroup) return;
    catchShowcaseActive = true;
    // 刚上岸 1.2s 内不受理 OK：钓鱼捏合的余势手形很像 OK，防误跳卡片
    okConfirmGesture.frames = 0;
    okConfirmGesture.cooldown = 72;
    // 从工艺等阶段经「换鱼/上一步」直接回到展示时，强制恢复绿水彩背景
    // （否则残留 CRAFTING 的蓝色渐变底+环境粒子+焦散——「点 UI 变蓝底」bug 的另一条路径）
    if (!document.body.classList.contains('intro-water-stages')) {
        currentPhase = PHASES.FISHING;
        applyPhaseLook(PHASES.FISHING);
        document.body.classList.add('intro-water-stages');
        waterRipple?.setWatercolorMode(true);
        if (ambientBackgroundParticles) ambientBackgroundParticles.visible = false;
        if (causticsEffect) causticsEffect.mesh.visible = false;
        updatePhaseIndicator();
    }
    // 展示鱼专属补光：亮度对齐右侧知识卡片预览
    setLanternDisplayLights(true);
    // ensureShowcaseShadowFish(); // 远景鱼影：按用户要求停用（函数保留，想恢复解开这行即可）
    // 工艺资源预热：卡片阅读期间后台拉取工序 GLB（缓解「开始制灯」瞬间卡顿）
    ['./outputs-video/models/fish-outline.glb', './outputs-video/models/fish-skeleton.glb',
     './outputs-video/models/fish-fabric.glb', './outputs-video/models/fish-colored.glb']
        .forEach((u) => fetch(u).catch(() => {}));

    if (fishingLine) fishingLine.visible = false;
    hideNonTargetFish();
    resetSingleFishMaterial(fishMeshGroup);
    // v5：卡片展示的鱼不再发光（makeCaughtFishGlow 已停用，与右侧卡片预览观感一致）

    const origScale = fishMeshGroup.userData._originalScale || fishMeshGroup.scale.x;
    fishMeshGroup.userData._originalScale = origScale;
    fishMeshGroup.scale.setScalar(origScale);
    fishMeshGroup.visible = true;
    craftFishYaw = -Math.PI / 2;
    fishMeshGroup.position.set(CATCH_FISH_OFFSET.x, CATCH_FISH_OFFSET.y, CATCH_FISH_OFFSET.z);
    fishMeshGroup.quaternion.identity();
    fishMeshGroup.rotation.set(0, craftFishYaw, 0);

    controls.target.set(CATCH_CAM_TARGET.x, CATCH_CAM_TARGET.y, CATCH_CAM_TARGET.z);
    controls.update();

    showFishKnowledgeCard(currentFishIndex);

    spreadGesture.prevDist = 0;
    spreadGesture.accumDelta = 0;
    document.getElementById('ritual-cue')?.classList.add('is-hidden');

    const hintEl = document.getElementById('hint-text');
    if (hintEl) hintEl.textContent = '鱼影已上岸 · 查看卡片后进入工艺体验';

    cancelRevealAutoAdvance();
}

function beginCraftFromCatch() {
    cancelRevealAutoAdvance();
    setLanternDisplayLights(false); // 收掉展示补光
    hideShowcaseShadowFish();
    // Fix5：先拉起制灯叠层的暗底，覆盖切换瞬间可能露出的蓝色水波背景
    const overlay = document.getElementById('craft-video-overlay');
    if (overlay) { overlay.classList.remove('is-hidden'); overlay.setAttribute('aria-hidden', 'false'); }
    if (particleSceneActive) deactivateParticleScene(); // 结束鱼影显形，释放显存
    hideFishKnowledgeCard();
    catchShowcaseActive = false;
    if (fishingLine) {
        scene.remove(fishingLine);
        fishingLine = null;
    }
    controls.target.set(0, 0, 0);
    pendingCraftVideoOpen = true;
    if (currentPhase === PHASES.CRAFTING) {
        pendingCraftVideoOpen = false;
        enterCraftVideoExperience(true);
    } else {
        enterPhase(PHASES.CRAFTING);
    }
}

function setFishingBodyFx(mode) {
    document.body.classList.remove('fishing-struggle', 'fishing-tension');
    if (mode === 'tension') document.body.classList.add('fishing-tension');
    if (mode === 'struggle') document.body.classList.add('fishing-struggle');
}

function isRodControlActive() {
    return fishingRodConnected && currentPhase === PHASES.FISHING;
}

function syncFishingInputUI() {
    const rodActive = isRodControlActive();
    const gestureRing = document.getElementById('gesture-ring');
    const gestureProgress = document.getElementById('gesture-progress');
    const handSkeleton = document.getElementById('hand-skeleton');
    const particleGuide = document.getElementById('particle-guide');

    if (gestureRing) gestureRing.style.display = rodActive ? 'none' : '';
    if (gestureProgress && currentPhase === PHASES.FISHING) gestureProgress.style.display = rodActive ? 'none' : '';
    if (handSkeleton) handSkeleton.style.display = rodActive ? 'none' : '';
    if (particleGuide && currentPhase === PHASES.FISHING) particleGuide.style.display = rodActive ? 'none' : '';

    if (!rodActive) return;

    const root = document.getElementById('ritual-cue');
    const kicker = document.getElementById('ritual-kicker');
    const title = document.getElementById('ritual-title');
    const subtitle = document.getElementById('ritual-subtitle');
    const leftHand = document.querySelector('#ritual-gesture .hand-left');
    const rightHand = document.querySelector('#ritual-gesture .hand-right');
    if (root) {
        root.dataset.cue = 'fishing-rod';
        root.dataset.gesture = 'rod';
        root.classList.remove('is-hidden');
    }
    if (kicker) kicker.textContent = '钓鱼';
    const directionText = rodTargetDirection > 0 ? '顺时针' : (rodTargetDirection < 0 ? '逆时针' : '任意方向');
    const signedWindow = getRodTargetWindowText();
    if (title) title.textContent = fishingLineDropped ? `${directionText}旋转，稳住鱼线` : '旋转旋钮，放下鱼钩';
    if (subtitle) subtitle.textContent = rodTargetDirection === 0
        ? '先向任意方向转动旋钮，系统会沿着你的方向生成本轮随机目标。'
        : (fishingLineDropped
            ? `把数值保持在 ${signedWindow}，鱼影会被钓上岸。`
            : `本轮已锁定${directionText}，目标是 ${signedWindow}。`);
    if (leftHand) leftHand.textContent = '🎣';
    if (rightHand) rightHand.textContent = '';
    updateRodInlineMeter(rodRawValue);
}

// ═══════════════════════════════════════════════════════
// MediaPipe 手势
// ═══════════════════════════════════════════════════════
function handleFirstFishingPinch() {
    if (fishingLineDropped || currentPhase !== PHASES.FISHING) return;
    fishingLineDropped = true;
    fishingPinchCount = 1;
    fishingState = FISH_STATE.SWIMMING;
    fishingStateTimer = 0;
    createFishingLine();
    waterRipple?.addRippleAt(0.58, 0.46);
    const hintEl = document.getElementById('hint-text');
    if (hintEl) hintEl.textContent = '再次捏合，提起鱼线';
    updateFishingCueStep(1);
    syncFishingInputUI();
    showToast('再次捏合，提起鱼线 · PINCH AGAIN TO LIFT THE LINE', 2200);
}

function updateFishingCueStep(step) {
    const root = document.getElementById('ritual-cue');
    if (!root || currentPhase !== PHASES.FISHING) return;
    if (isRodControlActive()) {
        syncFishingInputUI();
        return;
    }
    root.dataset.fishingStep = String(step);
    const title = document.getElementById('ritual-title');
    const subtitle = document.getElementById('ritual-subtitle');
    if (step === 0) {
        if (title) title.textContent = '第一次捏合，放下鱼线';
        if (subtitle) subtitle.textContent = '用拇指与食指捏合，放下鱼线。松开手指后，再次捏合即可提线。';
    } else {
        if (title) title.textContent = '再次捏合，提起鱼线';
        if (subtitle) subtitle.textContent = '鱼线已经垂入水面。松开手指，再捏合一次，将鱼影提起。';
    }
}

function makeCaughtFishGlow() {
    fishMeshGroup?.traverse((obj) => {
        if (!obj.isMesh || !obj.material) return;
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        mats.forEach((mat) => {
            if (!mat.emissive) return;
            mat.emissive.setRGB(0.34, 0.2, 0.06);
            mat.emissiveIntensity = 0.42;
        });
    });
}

function handleSecondFishingPinch() {
    if (!fishingLineDropped || fishingPinchCount !== 1 || currentPhase !== PHASES.FISHING) return;
    fishingPinchCount = 2;
    fishingState = FISH_STATE.CAUGHT;
    fishingStateTimer = 0;
    setFishingBodyFx(null);
    hideNonTargetFish();
    resetSingleFishMaterial(fishMeshGroup);
    makeCaughtFishGlow();
    if (fishDartCtrl) {
        fishDartCtrl.pos.set(15, 2, fishDartCtrl.pos.z);
        fishDartCtrl.heading = Math.PI / 2;
    }
    waterRipple?.addRippleAt(0.58, 0.48);
    if (splashSystem && fishDartCtrl) {
        splashSystem.burst(fishDartCtrl.pos.x, fishDartCtrl.pos.y, { count: 42, power: 100, color: [0.72, 0.96, 1.0] });
    }
    const hintEl = document.getElementById('hint-text');
    if (hintEl) hintEl.textContent = '鱼影已上岸 · 请阅读结果卡片';
    startCatchShowcase();
}

function handleFishingPinchFrame(isPinching) {
    if (isRodControlActive()) return;
    if (currentPhase !== PHASES.FISHING || fishingState >= FISH_STATE.CAUGHT) return;
    if (!isPinching) {
        if (fishingPinchStableFrames > 0) setGestureProgress(0);
        fishingPinchStableFrames = 0;
        fishingPinchReleaseFrames++;
        if (fishingPinchReleaseFrames >= 6) fishingPinchReleased = true;
        return;
    }
    fishingPinchReleaseFrames = 0;
    if (!fishingPinchReleased) return;
    fishingPinchStableFrames++;
    setGestureProgress(fishingPinchStableFrames / 8, '🤏');
    if (fishingPinchStableFrames < 8) return;
    fishingPinchStableFrames = 0;
    setGestureProgress(0);
    fishingPinchReleased = false;
    if (fishingPinchCount === 0) handleFirstFishingPinch();
    else if (fishingPinchCount === 1) handleSecondFishingPinch();
}

function setupMediaPipe() {
    const video = document.getElementById('camera-video');
    const canvas = document.getElementById('camera-canvas');
    const ctx = canvas.getContext('2d');
    canvas.width = 160;
    canvas.height = 120;

    // 手势结果处理：保持原五阶段手势解析逻辑不变，
    // 由 src/hand-input.js (tasks-vision) 通过兼容结构驱动。
    function onHandResults(results) {
            // 绘制摄像头预览（隐藏的 canvas，仅内部使用）
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(results.image, 0, 0, canvas.width, canvas.height);

            // 获取全屏骨骼画布
            const skelCanvas = document.getElementById('hand-skeleton');
            const skelCtx = skelCanvas.getContext('2d');
            skelCanvas.width = window.innerWidth;
            skelCanvas.height = window.innerHeight;
            skelCtx.clearRect(0, 0, skelCanvas.width, skelCanvas.height);

            if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
                const landmarks = results.multiHandLandmarks[0];
                handData.detected = true;

                // 手掌中心 (wrist)
                handData.palmX = landmarks[0].x - 0.5;  // -0.5~0.5
                handData.palmY = landmarks[0].y - 0.5;

                const allLandmarks = results.multiHandLandmarks;
                const twoHands = allLandmarks.length >= 2;
                const hand0 = allLandmarks[0];
                const hand1 = twoHands ? allLandmarks[1] : null;

                if (craftVideoOpen) detectClapReturn(hand0);

                // 注意：鱼影显形环节「双手张开」本身就是溶解互动，不能再用「双手推开」推进
                // （会一张手就误触发跳转）。推进改由：完全化光保持 / 点按按钮 / 长时间超时。

                // 手指伸展计数（判断张手/握拳），需先于仪式手势检测更新
                {
                    let fingersUp = 0;
                    // 拇指：指尖x超过指根x（考虑左右手差异，用距手腕的距离判断）
                    const thumbTip = landmarks[4], thumbIP = landmarks[3];
                    const wristX = landmarks[0].x;
                    if (Math.abs(thumbTip.x - wristX) > Math.abs(thumbIP.x - wristX)) fingersUp++;
                    // 其他4指：指尖y < 近指节y（相对手掌方向）
                    if (landmarks[8].y < landmarks[6].y) fingersUp++;   // 食指
                    if (landmarks[12].y < landmarks[10].y) fingersUp++; // 中指
                    if (landmarks[16].y < landmarks[14].y) fingersUp++; // 无名指
                    if (landmarks[20].y < landmarks[18].y) fingersUp++; // 小指
                    handData.fingersUp = fingersUp;
                }
                updateWakePalmWave(landmarks[9].x, landmarks[9].y, handData.fingersUp >= 3);
                updateLanternSummonSweep(landmarks[9].x, handData.fingersUp >= 3);
                updateLanternDanceGesture(handData.fingersUp);
                updateLanternSwarmFollow(landmarks[9].x, landmarks[9].y, handData.fingersUp >= 3);
                updateOkConfirmGesture(isOkConfirmHand(landmarks));
                updateFxCycleGesture(isVSignHand(landmarks));

                // ── 仪式手势检测（制灯/放生阶段）────────────────────
                if (ritualCooldown > 0) ritualCooldown--;

                // 更新第二只手骨骼绘制（已在外层处理）

                if (currentPhase === PHASES.CRAFTING && !isMorphing && ritualCooldown === 0 && !craftVideoOpen) {

                    // ── 手势1：双手向两侧推开 → 进入 outputs-video 非遗工艺体验 ──
                    if (currentStage === 0) {
                        if (twoHands) {
                            const x0 = hand0[0].x, x1 = hand1[0].x;
                            const dist = Math.abs(x0 - x1);
                            const delta = dist - spreadGesture.prevDist;
                            if (delta > 0.002) { // 持续扩大
                                spreadGesture.accumDelta += delta;
                            } else {
                                spreadGesture.accumDelta = Math.max(0, spreadGesture.accumDelta - 0.005);
                            }
                            spreadGesture.prevDist = dist;
                            if (spreadGesture.accumDelta > 0.12) {
                                enterCraftVideoExperience();
                                spreadGesture.accumDelta = 0;
                            }
                        } else {
                            spreadGesture.accumDelta = Math.max(0, spreadGesture.accumDelta - 0.01);
                        }
                    }

                    // ── 手势2：单手从左到右缓慢抹过 → stage 1→2（骨架→糊纸）──
                    if (currentStage === 1) {
                        const px = handData.palmX; // -0.5~0.5
                        if (!wipeGesture.traveling && px < -0.2) {
                            // 手在左侧，开始抹
                            wipeGesture.traveling = true;
                            wipeGesture.startX = px;
                            wipeGesture.accumX = 0;
                        }
                        if (wipeGesture.traveling) {
                            const dx = px - (wipeGesture.startX + wipeGesture.accumX);
                            if (dx > 0) wipeGesture.accumX += dx; // 只累计向右的位移
                            if (wipeGesture.accumX > 0.35) {
                                triggerRitualGesture(2);
                                wipeGesture.traveling = false;
                                wipeGesture.accumX = 0;
                                wipeGesture.startX = null;
                            }
                        }
                        // 手移回左侧重置
                        if (px < -0.25) {
                            wipeGesture.traveling = false;
                            wipeGesture.accumX = 0;
                        }
                    }

                    // ── 手势3：握拳→张开 → stage 2→3（糊纸→上色）──
                    if (currentStage === 2) {
                        const fu = handData.fingersUp;
                        const isFistLike = fu <= 2;
                        const isOpenLike = fu >= 3;
                        if (isFistLike) {
                            bloomGesture.holdFistTime++;
                        } else {
                            if (bloomGesture.holdFistTime > 0) bloomGesture.holdFistTime--;
                        }
                        if (bloomGesture.holdFistTime > 10) {
                            bloomGesture.wasFist = true;
                        }
                        if (bloomGesture.wasFist && isOpenLike) {
                            triggerRitualGesture(3);
                            bloomGesture.wasFist = false;
                            bloomGesture.holdFistTime = 0;
                        }
                    }

                    // ── 手势4：双手靠近→向上托起 → stage 3→4（上色→鱼灯）──
                    if (currentStage === 3) {
                        if (twoHands) {
                            const x0 = hand0[0].x, x1 = hand1[0].x;
                            const y0 = hand0[0].y, y1 = hand1[0].y;
                            const hdist = Math.abs(x0 - x1);
                            const avgY = (y0 + y1) / 2;
                            if (hdist < 0.28) {
                                liftGesture.closeTime++;
                                if (liftGesture.closeTime > 6 && !liftGesture.wasClose) {
                                    liftGesture.wasClose = true;
                                    liftGesture.startY = avgY;
                                    liftGesture.riseAccum = 0;
                                }
                                if (liftGesture.wasClose && liftGesture.startY !== null) {
                                    const rise = liftGesture.startY - avgY; // Y减小=向上
                                    if (rise > liftGesture.riseAccum) liftGesture.riseAccum = rise;
                                    if (liftGesture.riseAccum > 0.08) {
                                        triggerRitualGesture(4);
                                        liftGesture.wasClose = false;
                                        liftGesture.closeTime = 0;
                                        liftGesture.startY = null;
                                        liftGesture.riseAccum = 0;
                                    }
                                }
                            } else {
                                liftGesture.closeTime = Math.max(0, liftGesture.closeTime - 2);
                                if (liftGesture.closeTime === 0) {
                                    liftGesture.wasClose = false;
                                    liftGesture.startY = null;
                                    liftGesture.riseAccum = 0;
                                }
                            }
                        } else {
                            liftGesture.closeTime = 0;
                            liftGesture.wasClose = false;
                            liftGesture.startY = null;
                            liftGesture.riseAccum = 0;
                        }
                    }
                }

                // ── 放生手势：张开五指+手腕上移 → 放生完成 ──
                if (
                    ritualCooldown === 0 &&
                    (
                        false ||
                        (currentPhase === PHASES.CRAFTING && currentStage === 4)
                    )
                ) {
                    const fu = handData.fingersUp;
                    const py = handData.palmY; // -0.5~0.5，负=上方
                    if (fu >= 4) {
                        releaseGesture.openTime++;
                        if (releaseGesture.openTime > 8 && releaseGesture.startY === null) {
                            releaseGesture.startY = py;
                            releaseGesture.riseAccum = 0;
                        }
                        if (releaseGesture.startY !== null) {
                            const rise = releaseGesture.startY - py; // palmY减小=手上移
                            if (rise > releaseGesture.riseAccum) releaseGesture.riseAccum = rise;
                            if (releaseGesture.riseAccum > 0.08) {
                                triggerRitualGesture('release');
                                releaseGesture.openTime = 0;
                                releaseGesture.startY = null;
                                releaseGesture.riseAccum = 0;
                            }
                        }
                    } else {
                        releaseGesture.openTime = Math.max(0, releaseGesture.openTime - 2);
                        if (releaseGesture.openTime === 0) {
                            releaseGesture.startY = null;
                            releaseGesture.riseAccum = 0;
                        }
                    }
                }

                // ── 更新提示文字 ──
                if (currentPhase === PHASES.CRAFTING && !isMorphing) {
                    const hint = GESTURE_HINTS[currentStage] || '';
                    const hintEl = document.getElementById('hint-text');
                    if (hintEl && hint) hintEl.textContent = hint;
                }
                if (currentPhase === PHASES.LANTERN_SWARM) {
                    const hintEl = document.getElementById('hint-text');
                    if (hintEl) {
                        hintEl.textContent = lanternDanceReleased
                            ? '鱼灯已汇入灯群 · 张开手掌移动，鱼群会柔和跟随你'
                            : '鱼灯游群 · 握拳后张开放飞专属鱼灯';
                    }
                }

                // 在全屏画布上绘制发光触控点
                drawHandGlow(skelCtx, landmarks, skelCanvas.width, skelCanvas.height);
                
                // 水面阶段：仅用食指触发单点涟漪，避免五指尖同时扰动
                if (waterRipple) {
                    if (currentPhase === PHASES.WATER) {
                        const fingerData = [{
                            x: 1.0 - landmarks[8].x,
                            y: 1.0 - landmarks[8].y,
                            active: true,
                        }];
                        waterRipple.setFingerPositions(fingerData);
                    } else {
                        const fingerIndices = [4, 8, 12, 16, 20];
                        const fingerData = fingerIndices.map(idx => ({
                            x: 1.0 - landmarks[idx].x,
                            y: 1.0 - landmarks[idx].y,
                            active: true,
                        }));
                        waterRipple.setFingerPositions(fingerData);
                    }
                }
                
                // 如果有第二只手
                if (results.multiHandLandmarks.length > 1) {
                    drawHandGlow(skelCtx, results.multiHandLandmarks[1], skelCanvas.width, skelCanvas.height);
                }

                // 捏合检测 (拇指4 vs 食指8) - 增大阈值防止误触
                const thumb = landmarks[4];
                const index = landmarks[8];
                const dx = thumb.x - index.x;
                const dy = thumb.y - index.y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                handData.pinchDist = dist;

                // 捏合阈值
                if (dist < 0.04) {
                    if (!handData.isPinching && handData.pinchCooldown <= 0) {
                        handData.isPinching = true;
                        handData.pinchCooldown = 60;
                        // 根据当前阶段决定行为
                        // 水面阶段：捏合不跳过过渡，让用户完整体验涟漪→鱼影→上浮
                        // CRAFTING阶段: 捏合不触发阶段切换，形态推进交给仪式手势
                    }
                } else if (dist > 0.08) {
                    handData.isPinching = false;
                }
                handleFishingPinchFrame(dist < 0.04);
                
                // 冷却递减
                if (handData.pinchCooldown > 0) handData.pinchCooldown--;

            } else {
                handData.detected = false;
                // 清除水波纹手指数据
                if (waterRipple) {
                    waterRipple.setFingerPositions([]);
                }
            }
    }

    // 统一手势总线：单摄像头 + tasks-vision，驱动上面的 onHandResults
    startHandInput({ video, onResults: onHandResults, numHands: 2 })
        .then(() => {
            console.log('[INFO] 摄像头/手势启动成功 (tasks-vision)');
            document.getElementById('camera-canvas')?.classList.add('ready');
        })
        .catch((err) => {
            console.warn('[WARN] 摄像头/MediaPipe 不可用，仅键盘/鼠标交互可用:', err);
        });
}

// ═══════════════════════════════════════════════════════
// 麦克风 / 吹气检测
// ═══════════════════════════════════════════════════════
async function setupMicrophone() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const source = audioCtx.createMediaStreamSource(stream);
        micAnalyser = audioCtx.createAnalyser();
        micAnalyser.fftSize = 256;
        micAnalyser.smoothingTimeConstant = 0.5;
        source.connect(micAnalyser);
        micDataArray = new Uint8Array(micAnalyser.frequencyBinCount);
        console.log('[INFO] 麦克风启动成功，吹气检测已激活');
        
        // 显示麦克风图标
        const micIcon = document.getElementById('mic-indicator');
        if (micIcon) micIcon.style.display = 'block';
    } catch (e) {
        console.warn('[WARN] 麦克风不可用:', e.message);
    }
}

/**
 * 检测吹气：分析低频(0-2kHz)的能量是否持续高于阈值
 * 吹气特征：宽频噪声（不像说话有明显谐波）
 */
function detectBlow() {
    if (!micAnalyser || !micDataArray) return 0;
    micAnalyser.getByteFrequencyData(micDataArray);
    
    // 分析低频区域 (bin 0~20 ≈ 0~1.7kHz at 44100Hz, fftSize=256)
    let lowEnergy = 0;
    const lowBins = 20;
    for (let i = 1; i < lowBins; i++) {
        lowEnergy += micDataArray[i];
    }
    lowEnergy /= (lowBins - 1);
    
    // 分析中频区域 (bin 20~60)
    let midEnergy = 0;
    for (let i = 20; i < 60; i++) {
        midEnergy += micDataArray[i];
    }
    midEnergy /= 40;
    
    // 吹气判定：低频强（>80）且中频也有能量（宽频噪声特征）
    const isBlowing = lowEnergy > 80 && midEnergy > 40;
    
    if (isBlowing) {
        // 吹气强度与低频能量成正比
        return Math.min((lowEnergy - 80) / 100, 1.0);
    }
    return 0;
}

// ═══════════════════════════════════════════════════════
// PeerJS 手机连接
// ═══════════════════════════════════════════════════════
let peerConnection = null;

function setupPeerConnection() {
    if (typeof Peer === 'undefined' || typeof qrcode === 'undefined') {
        console.warn('[WARN] PeerJS 或 QRCode 库未加载，手机连接不可用');
        return;
    }

    const peer = new Peer();
    peer.on('open', (id) => {
        console.log('[INFO] PeerJS ID:', id);
        
        // 生成二维码 URL
        const host = location.hostname || 'localhost';
        const port = location.port || '8081';
        const phoneUrl = `http://${host}:${port}/phone.html?peer=${id}`;
        
        const qrCanvas = document.getElementById('qr-canvas');
        if (qrCanvas) {
            // qrcode-generator 库 API
            const qr = qrcode(0, 'M');
            qr.addData(phoneUrl);
            qr.make();
            
            const ctx = qrCanvas.getContext('2d');
            const size = 120;
            qrCanvas.width = size;
            qrCanvas.height = size;
            const modules = qr.getModuleCount();
            const cellSize = size / modules;
            
            ctx.fillStyle = '#0a1a30';
            ctx.fillRect(0, 0, size, size);
            ctx.fillStyle = '#e0d0a0';
            for (let row = 0; row < modules; row++) {
                for (let col = 0; col < modules; col++) {
                    if (qr.isDark(row, col)) {
                        ctx.fillRect(col * cellSize, row * cellSize, cellSize + 0.5, cellSize + 0.5);
                    }
                }
            }
            console.log('[INFO] QR码已生成:', phoneUrl);
        }
    });

    peer.on('connection', (conn) => {
        console.log('[INFO] 手机已连接');
        peerConnection = conn;
        const qrStatus = document.getElementById('qr-status');
        if (qrStatus) qrStatus.textContent = '✅ 手机已连接';
        
        conn.on('data', (data) => {
            handlePhoneData(data);
        });
        
        conn.on('close', () => {
            console.log('[INFO] 手机断开连接');
            peerConnection = null;
            if (qrStatus) qrStatus.textContent = '❌ 已断开';
        });
    });

    peer.on('error', (err) => {
        console.warn('[WARN] PeerJS错误:', err.type);
    });

    // QR 码显示/隐藏
    const qrToggle = document.getElementById('qr-toggle');
    const qrContainer = document.getElementById('qr-container');
    const qrClose = document.getElementById('qr-close');
    
    if (qrToggle && qrContainer) {
        qrToggle.addEventListener('click', () => {
            qrContainer.style.display = 'block';
            qrToggle.style.display = 'none';
        });
    }
    if (qrClose && qrContainer && qrToggle) {
        qrClose.addEventListener('click', () => {
            qrContainer.style.display = 'none';
            qrToggle.style.display = 'block';
        });
    }
}

/**
 * 处理手机端发送的数据
 */
function handlePhoneData(data) {
    if (!data || !data.type) return;
    
    switch (data.type) {
        case 'hand':
            // 手机触摸区域映射为 handData
            handData.detected = data.detected !== false;
            if (data.palmX !== undefined) handData.palmX = data.palmX;
            if (data.palmY !== undefined) handData.palmY = data.palmY;
            if (data.fingersUp !== undefined) handData.fingersUp = data.fingersUp;
            if (data.pinchDist !== undefined) handData.pinchDist = data.pinchDist;
            break;
            
        case 'gesture':
            // 按钮触发的离散手势
            if (data.gesture === 'pinch') {
                handData.isPinching = true;
                handData.pinchCooldown = 60;
                if (currentPhase === PHASES.FISHING) {
                    if (!isRodControlActive()) {
                        if (fishingPinchCount === 0) handleFirstFishingPinch();
                        else if (fishingPinchCount === 1) handleSecondFishingPinch();
                    }
                } else if (currentPhase === PHASES.LANTERN_SWARM) {
                    releaseUserLantern();
                }
                setTimeout(() => { handData.isPinching = false; }, 300);
            } else if (data.gesture === 'ritual-next') {
                if (currentPhase === PHASES.CRAFTING) {
                    if (currentStage === 0) enterCraftVideoExperience();
                    else if (currentStage < STAGES.length - 1) triggerRitualGesture(currentStage + 1);
                    else triggerRitualGesture('release');
                }
            }
            break;
            
        case 'blow':
            break;
    }
}

// ═══════════════════════════════════════════════════════
// UI 交互绑定
// ═══════════════════════════════════════════════════════
function toggleDevPanel(force) {
    const panel = document.getElementById('control-panel');
    if (!panel) return;
    const open = force === undefined ? !panel.classList.contains('dev-open') : force;
    panel.classList.toggle('dev-open', open);
}

function restartExperience() {
    cancelRevealAutoAdvance();
    if (particleSceneActive) deactivateParticleScene();
    if (craftVideoOpen) closeCraftVideoOverlay();
    catchShowcaseActive = false;
    hideFishKnowledgeCard();
    lanternSummonStage = 'idle';
    currentStage = 0;
    applyFishTextures(currentFishIndex, 0);
    transitionToPhase(PHASES.WATER);
    void setBgmTrack('waves', { restart: true });
    showToast('↺ 已重新开始', 1500);
}

function setupHud() {
    document.getElementById('hud-restart')?.addEventListener('click', restartExperience);
    document.getElementById('hud-switch-fish')?.addEventListener('click', () => {
        switchFishType((currentFishIndex + 1) % FISH_TYPES.length);
    });
    document.getElementById('hud-mute')?.addEventListener('click', (e) => {
        const audio = getBgmAudio();
        if (!sfxMuted && (!bgmUnlocked || audio?.paused)) {
            void setBgmTrack(bgmMode || 'waves', { restart: false });
            updateBgmButtonState();
            return;
        }
        sfxMuted = !sfxMuted;
        syncBgmMuteState();
    });
    document.getElementById('hud-dev')?.addEventListener('click', () => toggleDevPanel());
    document.getElementById('hud-back')?.addEventListener('click', goBack);

    // 鱼影显形粒子面板：5 种溶解特效 + 溶解滑块
    document.querySelectorAll('#reveal-panel .rp-fx button').forEach((b) => {
        b.addEventListener('click', () => {
            revealFxMode = parseInt(b.dataset.fx) || 0;
            if (particleScene) particleScene.setFxMode(revealFxMode);
            syncRevealPanel();
            revealIdle = 0; // 视为交互，刷新无人值守计时
        });
    });
    document.getElementById('rp-dissolve')?.addEventListener('input', (e) => {
        if (particleScene) particleScene.setDissolveManual(parseFloat(e.target.value));
        revealIdle = 0;
    });
    // 粒子参数板（pointcloud-demo 式）：大小 / 饱和
    document.getElementById('rp-size')?.addEventListener('input', (e) => {
        if (particleScene) particleScene.setParticleSize(parseFloat(e.target.value));
        revealIdle = 0;
    });
    document.getElementById('rp-sat')?.addEventListener('input', (e) => {
        if (particleScene) particleScene.setSaturation(parseFloat(e.target.value));
        revealIdle = 0;
    });
}

// 返回上一步：处理制灯视频/鱼影显形/灯阶段的逆向跳转
function goBack() {
    if (craftVideoOpen) {            // 科普(制灯视频) → 鱼影显形
        returnToReveal();
        return;
    }
    if (catchShowcaseActive) {       // 鱼影显形 → 重新钓鱼
        cancelRevealAutoAdvance();
        if (particleSceneActive) deactivateParticleScene();
        enterPhase(PHASES.FISHING);
        return;
    }
    switch (currentPhase) {
        case PHASES.LANTERN_SWARM: enterPhase(PHASES.LANTERN_RECEIVE); break;
        case PHASES.LANTERN_RECEIVE:                 // 鱼灯领取 → 回到制灯视频
            clearLanternDanceTimers();
            lanternSummonStage = 'idle';             // 否则 enterCraftVideoExperience 会被守卫拦下
            setLanternNightMode(false);
            currentPhase = PHASES.CRAFTING;
            enterCraftVideoExperience(true);
            break;
        case PHASES.CRAFTING: returnToReveal(); break;
        case PHASES.FISHING: enterPhase(PHASES.WATER); break;
        default: showToast('已是第一步', 1200);
    }
}

// 回到「鱼影显形」环节（保留已钓起的鱼）
function returnToReveal() {
    cancelCraftVideoFallback();
    closeCraftVideoOverlay();
    clearLanternDanceTimers();
    lanternSummonStage = 'idle';
    setLanternNightMode(false);
    document.getElementById('gesture-progress')?.style.setProperty('display', 'none');
    currentPhase = PHASES.FISHING;
    // 这里不走 enterPhase（避免整套状态重置），需手动恢复水彩背景——
    // 否则残留 CRAFTING 的蓝色渐变底+环境粒子+焦散（「点上一步变蓝底」bug）
    applyPhaseLook(PHASES.FISHING);
    document.body.classList.add('intro-water-stages');
    waterRipple?.setWatercolorMode(true);
    if (ambientBackgroundParticles) ambientBackgroundParticles.visible = false;
    if (causticsEffect) causticsEffect.mesh.visible = false;
    fishingState = FISH_STATE.CAUGHT;
    catchShowcaseActive = false;
    if (fishMeshGroup) {
        startCatchShowcase();
    } else {
        enterPhase(PHASES.FISHING);
    }
    updatePhaseIndicator();
}

function setupUI() {
    bindBgmAutoStart();
    syncBgmMuteState();
    void setBgmTrack('waves', { restart: true });
    setupHud();
    // 开发面板关闭按钮（✕）
    document.getElementById('panel-toggle').addEventListener('click', () => {
        toggleDevPanel(false);
    });

    document.getElementById('ritual-dismiss')?.addEventListener('click', () => {
        document.getElementById('ritual-cue')?.classList.add('is-hidden');
    });
    document.getElementById('craft-video-close')?.addEventListener('click', finishCraftVideoAndRevealLantern);
    document.getElementById('craft-video-back')?.addEventListener('click', returnToReveal);
    document.getElementById('fkc-enter-craft')?.addEventListener('click', beginCraftFromCatch);
    document.getElementById('lantern-summon-btn')?.addEventListener('click', () => {
        if (lanternSummonStage === 'danceReleaseReady') releaseUserLantern();
        else if (lanternSummonStage === 'particles') completeLanternParticleReceive();
        else if (lanternSummonStage === 'model') enterLanternDance();
        else handleSummonLantern();
    });

    // ── Arduino 钓竿控制 ──────────────────────────────────────
    setupFishingRodUI();
    showFishingRodPanel();

    // 水面阶段：单击触发涟漪（无需摄像头）
    let clickStart = null;
    renderer.domElement.addEventListener('mousedown', (e) => {
        if (e.button !== 0 || currentPhase !== PHASES.WATER) return;
        clickStart = { x: e.clientX, y: e.clientY };
    });
    renderer.domElement.addEventListener('mousemove', (e) => {
        if (!clickStart || currentPhase !== PHASES.WATER) return;
        const rect = renderer.domElement.getBoundingClientRect();
        updateWakePalmWave(
            (e.clientX - rect.left) / rect.width,
            (e.clientY - rect.top) / rect.height,
            true
        );
    });
    let lastClickRipple = 0;
    renderer.domElement.addEventListener('mouseup', (e) => {
        if (e.button !== 0 || !clickStart || currentPhase !== PHASES.WATER || !waterRipple) return;
        const moved = Math.hypot(e.clientX - clickStart.x, e.clientY - clickStart.y);
        clickStart = null;
        if (moved > 8) return;
        const now = performance.now();
        if (now - lastClickRipple < 600) return;
        lastClickRipple = now;
        const rect = renderer.domElement.getBoundingClientRect();
        waterRipple.addRippleAt(
            (e.clientX - rect.left) / rect.width,
            1 - (e.clientY - rect.top) / rect.height
        );
        fishAttractionTimer += 0.4;
    });

    // 滑块绑定
    document.getElementById('ctrl-size').addEventListener('input', e => {
        uniforms.uSize.value = parseFloat(e.target.value);
    });
    document.getElementById('ctrl-fluid')?.addEventListener('input', e => {
        uniforms.uFluidStrength.value = parseFloat(e.target.value);
    });
    document.getElementById('ctrl-breath').addEventListener('input', e => {
        uniforms.uBreathAmp.value = parseFloat(e.target.value);
    });
    document.getElementById('ctrl-threshold').addEventListener('input', e => {
        uniforms.uThreshold.value = parseFloat(e.target.value);
    });

    // 颜色按钮
    document.querySelectorAll('.color-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.color-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const color = btn.getAttribute('data-color');
            if (color === 'none') {
                uniforms.uTintStrength.value = 0;
            } else {
                const c = new THREE.Color(color);
                uniforms.uTintColor.value.set(c.r, c.g, c.b);
                uniforms.uTintStrength.value = 1.0;
            }
        });
    });

    // 自定义颜色
    document.getElementById('custom-color').addEventListener('input', e => {
        document.querySelectorAll('.color-btn').forEach(b => b.classList.remove('active'));
        const c = new THREE.Color(e.target.value);
        uniforms.uTintColor.value.set(c.r, c.g, c.b);
        uniforms.uTintStrength.value = 1.0;
    });

    // 水面色调按钮
    document.querySelectorAll('.water-color-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.water-color-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const theme = btn.getAttribute('data-water');
            if (waterRipple) waterRipple.setColorTheme(theme);
        });
    });

    // 场景阶段按钮
    document.querySelectorAll('.stage-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const phase = btn.getAttribute('data-phase');
            if (phase) enterPhase(phase);
        });
    });

    const stageDotPhases = [PHASES.WATER, PHASES.FISHING, PHASES.CRAFTING, PHASES.LANTERN_RECEIVE, PHASES.LANTERN_SWARM];
    document.querySelectorAll('#stage-indicator .dot').forEach((dot) => {
        const idx = Number(dot.dataset.idx);
        if (idx === 2) dot.textContent = '🛠️';
        dot.setAttribute('role', 'button');
        dot.setAttribute('tabindex', '0');
        const jump = () => {
            const phase = stageDotPhases[idx];
            if (phase) enterPhase(phase);
        };
        dot.addEventListener('click', jump);
        dot.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                jump();
            }
        });
    });

    // 手势超时设置
    for (let i = 0; i < 5; i++) {
        const slider = document.getElementById(`ctrl-timeout-${i}`);
        const label = document.getElementById(`timeout-val-${i}`);
        if (!slider || !label) continue;
        slider.value = String(RITUAL_TIMEOUTS[i]);
        label.textContent = `${RITUAL_TIMEOUTS[i]}s`;
        slider.addEventListener('input', (e) => {
            const value = Math.max(0, parseInt(e.target.value, 10) || 0);
            RITUAL_TIMEOUTS[i] = value;
            label.textContent = `${value}s`;
            resetRitualTimeout();
        });
    }

    const resetBtn = document.getElementById('reset-defaults');
    if (resetBtn) {
        resetBtn.addEventListener('click', () => {
            resetTimeoutDefaults();
        });
    }
}

function resetTimeoutDefaults() {
    RITUAL_TIMEOUTS = [...DEFAULTS.ritualTimeouts];
    for (let i = 0; i < 5; i++) {
        const slider = document.getElementById(`ctrl-timeout-${i}`);
        const label = document.getElementById(`timeout-val-${i}`);
        if (!slider || !label) continue;
        slider.value = String(RITUAL_TIMEOUTS[i]);
        label.textContent = `${RITUAL_TIMEOUTS[i]}s`;
    }
    resetRitualTimeout();
}

function updateUI() {
    // 场景阶段按钮高亮
    document.querySelectorAll('.stage-btn').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-phase') === currentPhase);
    });
    updatePhaseIndicator();
}

// ═══════════════════════════════════════════════════════
// Toast 提示
// ═══════════════════════════════════════════════════════
function showToast(msg, duration = 2000) {
    let toast = document.getElementById('fish-toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'fish-toast';
        toast.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);padding:10px 24px;background:rgba(0,0,0,0.8);color:#fff;border-radius:8px;font-size:16px;z-index:9999;opacity:0;transition:opacity 0.3s;pointer-events:none;';
        document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.style.opacity = '1';
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => { toast.style.opacity = '0'; }, duration);
}

// ═══════════════════════════════════════════════════════
// 键盘事件
// ═══════════════════════════════════════════════════════
function onKeyDown(e) {
    if (e.code === 'KeyR') releaseUserLantern();
    if (e.code === 'KeyD') toggleDevPanel();           // 开发面板开关
    // 调试：手动切换粒子场景（不改变阶段），便于对比鱼影显形效果
    if (e.code === 'KeyG') {
        if (particleSceneActive) deactivateParticleScene();
        else activateParticleScene();
    }
    if (e.code === 'KeyP' && currentPhase === PHASES.FISHING) {
        if (fishingPinchCount === 0) handleFirstFishingPinch();
        else if (fishingPinchCount === 1) handleSecondFishingPinch();
    }
    if (e.code === 'Space') {
        e.preventDefault();
        if (currentPhase === PHASES.WATER) {
            advancePhase(); // 进入钓鱼
        } else if (currentPhase === PHASES.FISHING) {
            if (catchShowcaseActive) {
                beginCraftFromCatch();
            } else if (fishingState < FISH_STATE.CAUGHT) {
                showToast('🎣 请等待完整钓鱼过程…', 1400);
            }
        } else if (currentPhase === PHASES.CRAFTING) {
            if (craftVideoOpen) {
                finishCraftVideoAndRevealLantern();
            } else if (currentStage === 0) {
                enterCraftVideoExperience();
            } else if (currentStage < STAGES.length - 1) {
                triggerRitualGesture(currentStage + 1); // 调试兜底：按顺序模拟仪式完成
            } else {
                triggerRitualGesture('release');
            }
        } else if (currentPhase === PHASES.LANTERN_SWARM) {
            advancePhase(); // 回到水面
        }
    }
    // 数字键1-4切换阶段（调试用）
    if (!e.shiftKey) {
        if (e.code === 'Digit1') enterPhase(PHASES.WATER);
        if (e.code === 'Digit2') enterPhase(PHASES.FISHING);
        if (e.code === 'Digit3') enterPhase(PHASES.CRAFTING);
        if (e.code === 'Digit4') enterPhase(PHASES.LANTERN_RECEIVE);
        if (e.code === 'Digit5') enterPhase(PHASES.LANTERN_SWARM);
    }

    // Shift+1-5 切换鱼种（隐藏快捷键）
    if (e.shiftKey) {
        if (e.code === 'Digit1') switchFishType(0);
        if (e.code === 'Digit2') switchFishType(1);
        if (e.code === 'Digit3') switchFishType(2);
        if (e.code === 'Digit4') switchFishType(3);
        if (e.code === 'Digit5') switchFishType(4);
    }

    // 左右方括号也可切换鱼种
    if (e.code === 'BracketLeft')  switchFishType(currentFishIndex - 1);
    if (e.code === 'BracketRight') switchFishType(currentFishIndex + 1);

    if (e.code === 'Escape' && craftVideoOpen) {
        finishCraftVideoAndRevealLantern();
    }
}

// ═══════════════════════════════════════════════════════
// 窗口大小调整
// ═══════════════════════════════════════════════════════
function onResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    if (mainComposer) mainComposer.setSize(window.innerWidth, window.innerHeight);
    if (bloomComposer) bloomComposer.setSize(window.innerWidth, window.innerHeight);
    if (waterRipple) waterRipple.resize(window.innerWidth, window.innerHeight);
    fitNightBackgroundCover();
}

// ═══════════════════════════════════════════════════════
// 钓鱼线 + 鱼钩 (2D线条)
// ═══════════════════════════════════════════════════════
function createFishingLine() {
    if (fishingLine) { scene.remove(fishingLine); fishingLine = null; }
    const group = new THREE.Group();

    // 鱼线：金丝（Windows/ANGLE 下 linewidth 恒为 1px，光感靠下面的 additive 发光双线）
    const lineMat = new THREE.LineBasicMaterial({ color: 0xd9b25f, linewidth: 1.5, transparent: true, opacity: 0.85 });
    const lineGeo = new THREE.BufferGeometry();
    // 初始点位，后续 animate 中动态更新
    const pts = [];
    for (let i = 0; i <= 20; i++) {
        pts.push(0, 0, 0);
    }
    lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const line = new THREE.Line(lineGeo, lineMat);
    line.name = 'fishing-line';
    group.add(line);

    // 金丝发光层：共享同一份 BufferGeometry（零额外 CPU），additive 叠出柔光
    const glowMat = new THREE.LineBasicMaterial({
        color: 0xffe7a8,
        transparent: true,
        opacity: 0.22,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
    });
    const glowLine = new THREE.Line(lineGeo, glowMat);
    glowLine.name = 'fishing-line-glow';
    group.add(glowLine);

    // 钩头金珠：水墨画面里的一粒暖光
    const beadTex = createRadialGlowTexture('rgba(255, 226, 160, 1)', 64);
    const beadMat = new THREE.SpriteMaterial({
        map: beadTex,
        transparent: true,
        opacity: 0.85,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
    });
    const bead = new THREE.Sprite(beadMat);
    bead.name = 'fishing-hook-bead';
    bead.scale.set(4.5, 4.5, 1);
    group.add(bead);

    // 鱼钩：简单的弯钩形状
    const hookMat = new THREE.LineBasicMaterial({ color: 0xb98c3a, linewidth: 2 });
    const hookShape = new THREE.BufferGeometry();
    const hookPts = [
        0, 0, 0,       // 连接点
        0, -3, 0,      // 直杆
        1, -5, 0,      // 弯曲开始
        2, -4.5, 0,    // 钩尖
        1.5, -3.5, 0,  // 倒刺
    ];
    hookShape.setAttribute('position', new THREE.Float32BufferAttribute(hookPts, 3));
    const hook = new THREE.Line(hookShape, hookMat);
    hook.name = 'fishing-hook';
    group.add(hook);
    
    group.visible = true;
    scene.add(group);
    fishingLine = group;
}

function updateFishingLine(time) {
    if (!fishingLine) return;
    const line = fishingLine.getObjectByName('fishing-line');
    const hook = fishingLine.getObjectByName('fishing-hook');
    if (!line) return;
    
    // 鱼线从画面上方（竿的位置）垂下到鱼钩位置
    const rodX = 15;  // 竿在右上方
    const rodY = 65;  // 画面顶部
    
    // 鱼钩终点：正常摆动 or 跟随鱼嘴位置（咬钩后）
    let hookX, hookY;
    if (fishingState >= FISH_STATE.BITING && fishDartCtrl) {
        // 咬钩后鱼线连接鱼嘴（鼻子方向偏移）
        const dir = fishDartCtrl.direction;
        const mouthOffset = 12;
        hookX = fishDartCtrl.pos.x + dir.x * mouthOffset;
        hookY = fishDartCtrl.pos.y + dir.y * mouthOffset;
    } else {
        hookX = rodX + Math.sin(time * 0.8) * 5;
        hookY = -10 + Math.sin(time * 0.5) * 3;
    }
    
    // 挣扎时线的抖动；咬钩后也有张力
    const tensionBase = fishingState === FISH_STATE.STRUGGLING ? 1.2 : (fishingState === FISH_STATE.BITING ? 0.6 : 0);
    const tension = tensionBase + Math.sin(time * (fishingState === FISH_STATE.STRUGGLING ? 10 : 7)) * tensionBase * 0.4;
    
    // 用二次贝塞尔曲线生成鱼线点（金丝：随风轻摆 + 更重的垂坠感）
    const positions = line.geometry.attributes.position.array;
    const segments = 20;
    const ctrlX = (rodX + hookX) * 0.5 + tension + Math.sin(time * 0.9) * 2.2;
    const ctrlY = (rodY + hookY) * 0.5 + 13;
    
    for (let i = 0; i <= segments; i++) {
        const t = i / segments;
        const x = (1-t)*(1-t)*rodX + 2*(1-t)*t*ctrlX + t*t*hookX;
        const y = (1-t)*(1-t)*rodY + 2*(1-t)*t*ctrlY + t*t*hookY;
        positions[i*3] = x;
        positions[i*3+1] = y;
        positions[i*3+2] = 1;
    }
    line.geometry.attributes.position.needsUpdate = true;
    
    // 更新鱼钩位置
    if (hook) {
        hook.position.set(hookX, hookY, 1);
        // 咬钩后隐藏独立鱼钩（鱼嘴含着）
        hook.visible = fishingState < FISH_STATE.BITING;
    }

    // 钩头金珠跟随，亮度随轻微脉动
    const bead = fishingLine.getObjectByName('fishing-hook-bead');
    if (bead) {
        bead.position.set(hookX, hookY - 3.5, 1);
        bead.material.opacity = 0.62 + Math.sin(time * 2.6) * 0.18;
        bead.visible = fishingState < FISH_STATE.BITING;
    }
}

// ═══════════════════════════════════════════════════════
// Arduino 钓鱼交互系统
// ═══════════════════════════════════════════════════════

function randomRodTargetMagnitude() {
    return Math.floor(30 + Math.random() * 46); // 30..75
}

function lockRodTargetFromValue(value) {
    const direction = Math.sign(value);
    if (!direction || rodTargetDirection !== 0) return false;
    rodTargetDirection = direction;
    rodTargetValue = randomRodTargetMagnitude() * direction;
    return true;
}

function getRodTargetBounds() {
    if (rodTargetDirection === 0 || rodTargetValue === 0) return null;
    const low = Math.max(1, Math.abs(rodTargetValue) - rodTargetTolerance);
    const high = Math.min(100, Math.abs(rodTargetValue) + rodTargetTolerance);
    return rodTargetDirection > 0 ? [low, high] : [-high, -low];
}

function getRodTargetWindowText() {
    const bounds = getRodTargetBounds();
    if (!bounds) return '等待方向';
    const [a, b] = bounds;
    const fmt = (v) => `${v > 0 ? '+' : ''}${Math.round(v)}`;
    return `${fmt(a)} 到 ${fmt(b)}`;
}

function signedNumberText(value) {
    return `${value > 0 ? '+' : ''}${Math.round(value)}`;
}

function updateRodInlineMeter(value) {
    const meter = document.getElementById('rod-inline-meter');
    const current = document.getElementById('rod-inline-current');
    const target = document.getElementById('rod-inline-target');
    const fill = document.getElementById('rod-inline-fill');
    const targetZone = document.getElementById('rod-inline-target-zone');
    const status = document.getElementById('rod-inline-status');
    if (!meter) return;

    const signedValue = Math.max(-100, Math.min(100, Number(value) || 0));
    if (current) current.textContent = `当前 ${signedNumberText(signedValue)}`;
    if (target) target.textContent = `目标 ${getRodTargetWindowText()}`;

    if (fill) {
        fill.classList.toggle('is-negative', signedValue < 0);
        fill.style.width = `${Math.min(50, Math.abs(signedValue) * 0.5)}%`;
    }

    if (targetZone) {
        const bounds = getRodTargetBounds();
        if (!bounds) {
            targetZone.style.left = '50%';
            targetZone.style.right = 'auto';
            targetZone.style.width = '0';
        } else {
            const [a, b] = bounds;
            const low = Math.min(a, b);
            const high = Math.max(a, b);
            targetZone.style.left = `${50 + low * 0.5}%`;
            targetZone.style.right = 'auto';
            targetZone.style.width = `${Math.max(2, (high - low) * 0.5)}%`;
        }
    }

    if (status) {
        if (rodTargetDirection === 0) status.textContent = '任意方向旋转，放下鱼钩';
        else if (isRodValueInSuccessWindow(signedValue)) status.textContent = '数值正好，稳住';
        else status.textContent = `继续调整到 ${getRodTargetWindowText()}`;
    }
}

function isRodValueInSuccessWindow(value) {
    const bounds = getRodTargetBounds();
    if (!bounds) return false;
    const [a, b] = bounds;
    return value >= Math.min(a, b) && value <= Math.max(a, b);
}

function handleRodTensionInput(value) {
    if (!isRodControlActive() || fishingState >= FISH_STATE.CAUGHT) return;

    const movedEnough = Math.abs(value - rodLastTension) >= 2 || Math.abs(value) >= 6;
    if (rodTargetDirection === 0 && movedEnough && Math.sign(value) !== 0) {
        lockRodTargetFromValue(value);
        syncFishingInputUI();
        showToast(`本轮目标：${getRodTargetWindowText()}`, 1800);
    }

    const targetSide = Math.sign(value) === rodTargetDirection;
    const movedTowardTarget = targetSide && Math.abs(value - rodLastTension) >= 2;
    rodLastTension = value;

    if (!fishingLineDropped) {
        if (movedTowardTarget || (targetSide && Math.abs(value) >= 6)) {
            handleFirstFishingPinch();
            rodFishingState = 'biting';
            rodFishingStartTime = Date.now();
            rodHoldStart = 0;
            playRitualSfx(2);
            updateTensionUI(value);
        }
        return;
    }

    if (fishingPinchCount !== 1) return;

    const inRange = isRodValueInSuccessWindow(value);
    if (inRange) {
        if (rodFishingState !== 'fighting') {
            rodFishingState = 'fighting';
            showToast('数值正好，稳住旋钮...');
        }
        if (!rodHoldStart) rodHoldStart = Date.now();
        if (Date.now() - rodHoldStart > 300) {
            finishRodFishing();
        }
    } else {
        rodHoldStart = 0;
        rodFishingState = 'biting';
    }

    rodTugStrength = Math.min(1.0, Math.abs(value) / 100);
    syncFishingInputUI();
}

function handleRodCatchShowcaseInput(value) {
    if (!fishingRodConnected || !catchShowcaseActive || rodZeroAdvanceDone) return;
    if (Date.now() < rodZeroAdvanceReadyAt) return;
    if (Math.abs(value) <= 3) {
        rodZeroAdvanceDone = true;
        beginCraftFromCatch();
    }
}

/**
 * 初始化钓竿UI和事件监听
 */
function setupFishingRodUI() {
    const connectBtn = document.getElementById('connect-fishing-rod');
    const panel = document.getElementById('fishing-rod-panel');
    
    if (!connectBtn) return;
    
    // 连接按钮事件
    connectBtn.addEventListener('click', async () => {
        if (fishingRodConnected) return;
        const ok = await rod.connect();
        if (ok) {
            fishingRodConnected = true;
            connectBtn.textContent = '✓ 已连接';
            connectBtn.disabled = true;
            showToast('钓竿已连接：按提示方向旋转，钓上鱼后按按钮进入工艺体验。');
            hideFishingRodPanel();
            syncFishingInputUI();
            updateTensionUI(rodRawValue);
        } else {
            showToast('❌ 连接失败，请检查Arduino设备');
        }
    });
    
    // 监听编码器值变化（0-100张力百分比）
    window.addEventListener('encoder-update', (e) => {
        const payload = typeof e.detail === 'number'
            ? { raw: e.detail, abs: Math.abs(e.detail) }
            : e.detail;
        rodRawValue = Math.max(-100, Math.min(100, Number(payload?.raw ?? payload?.value ?? 0)));
        rodTension = Math.min(100, Math.abs(Number(payload?.abs ?? rodRawValue)));
        updateTensionUI(rodTension);
        
        // 更新钓线长度（逆向映射：高张力=短钓线）
        rodLineLength = 100 - rodTension;
        
        // 鱼的挣扎程度随张力增加
        if (rodFishingState === 'fighting') {
            rodTugStrength = Math.min(1.0, rodTension / 100);
        }
        
        // 张力过高警告（>80%）
        if (rodTension > 80) {
            showTensionWarning();
        }
        
        if (currentPhase === PHASES.FISHING) {
            if (catchShowcaseActive) handleRodCatchShowcaseInput(rodRawValue);
            else if (isRodControlActive()) handleRodTensionInput(rodRawValue);
            else updateRodFishingState();
        }
    });
    
    // 监听钓竿按钮按下（尝试钓起）
    window.addEventListener('button-press', (e) => {
        if (e.detail.type === 'hook' && currentPhase === PHASES.FISHING && !catchShowcaseActive) {
            tryHookFish();
        }
    });
}

/**
 * 显示钓竿控制面板
 */
function showFishingRodPanel() {
    const panel = document.getElementById('fishing-rod-panel');
    if (panel) panel.style.display = fishingRodConnected ? 'none' : 'block';
}

/**
 * 隐藏钓竿控制面板
 */
function hideFishingRodPanel() {
    const panel = document.getElementById('fishing-rod-panel');
    if (panel) panel.style.display = 'none';
}

/**
 * 更新张力UI进度条
 */
function updateTensionUI(value) {
    const bar = document.getElementById('tension-bar');
    const text = document.getElementById('tension-text');
    const status = document.getElementById('fishing-status');

    const absValue = Math.min(100, Math.abs(value));
    const signedValue = isRodControlActive() ? rodRawValue : value;
    if (bar) bar.style.width = absValue + '%';
    if (text) text.textContent = isRodControlActive()
        ? `${signedValue > 0 ? '+' : ''}${Math.round(signedValue)}`
        : `${Math.round(absValue)}%`;
    updateRodInlineMeter(signedValue);
    
    // 状态文字
    if (status) {
        if (!fishingRodConnected) {
            status.textContent = '未连接';
        } else if (rodFishingState === 'idle') {
            status.textContent = rodTargetDirection === 0
                ? '等待旋钮 · 任意方向'
                : `等待旋钮 · 目标 ${getRodTargetWindowText()}`;
        } else if (rodFishingState === 'biting') {
            status.textContent = `鱼咬钩了 · 目标 ${getRodTargetWindowText()}`;
        } else if (rodFishingState === 'fighting') {
            const inRange = isRodValueInSuccessWindow(rodRawValue);
            status.textContent = inRange ? '数值正好 · 稳住' : `目标 ${getRodTargetWindowText()}`;
        }
    }
}

/**
 * 显示张力警告
 */
function showTensionWarning() {
    const warning = document.getElementById('tension-warning');
    if (warning) {
        warning.style.display = 'block';
        setTimeout(() => { warning.style.display = 'none'; }, 800);
    }
}

/**
 * 更新钓鱼状态机
 */
function updateRodFishingState() {
    if (rodFishingState === 'idle' && rodTension > 10) {
        // 鱼开始咬钩
        rodFishingState = 'biting';
        rodFishingStartTime = Date.now();
        showToast('🐟 鱼咬钩了！');
        // 音效反馈（使用现有的playRitualSfx）
        playRitualSfx(2);  // Wipe阶段的音效
        
        // 触发鱼的挣扎动画
        if (targetFishInstance && targetFishInstance.swimCtrl) {
            rodTugStrength = 0.3;
            rodTugTimer = 0;
        }
    }
    
    if (rodFishingState === 'biting') {
        // 高张力时转为"对抗"状态（遛鱼）
        if (rodTension > 50) {
            rodFishingState = 'fighting';
            showToast('⚡ 鱼开始挣扎！需要保持张力在30-70%范围内...');
        }
        // 10秒无反应则鱼离开
        else if (Date.now() - rodFishingStartTime > 10000) {
            rodFishingState = 'idle';
            rodTugStrength = 0;
            showToast('😅 鱼跑掉了，再来一次！');
        }
    }
    
    let holdStart = rodFishingState.holdStart || 0;
    if (rodFishingState === 'fighting') {
        // 检查张力是否在成功范围内
        if (rodTension >= rodFishingSuccessWindow[0] && rodTension <= rodFishingSuccessWindow[1]) {
            // 保持在正确范围内3秒则成功
            if (!holdStart) {
                holdStart = Date.now();
            } else if (Date.now() - holdStart > 3000) {
                // 成功钓起！
                finishRodFishing();
                return;
            }
        } else {
            holdStart = 0;
        }
        
        // 30秒超时则失败
        if (Date.now() - rodFishingStartTime > 30000) {
            rodFishingState = 'idle';
            rodTugStrength = 0;
            showToast('⏱️ 时间已到，鱼跑掉了！');
        }
    }
}

/**
 * 尝试钓起（按钮按下时调用）
 */
function tryHookFish() {
    if (rodFishingState !== 'fighting') {
        showToast('💡 等待鱼咬钩，然后调整张力...');
        return;
    }
    
    // 检查张力是否在正确范围
    const ok = isRodControlActive()
        ? isRodValueInSuccessWindow(rodRawValue)
        : rodTension >= rodFishingSuccessWindow[0] && rodTension <= rodFishingSuccessWindow[1];
    if (ok) {
        finishRodFishing();
    } else {
        showToast(`数值不对，目标范围：${getRodTargetWindowText()}`);
    }
}

/**
 * 完成钓鱼，进入下一阶段
 */
function finishRodFishing() {
    if (fishingState >= FISH_STATE.CAUGHT || catchShowcaseActive) return;
    showToast('钓上鱼了！');
    playRitualSfx(4);  // Lift阶段的音效

    handleSecondFishingPinch();
    rodFishingState = 'idle';
    rodHoldStart = 0;
    rodTugStrength = 0;
    rodZeroAdvanceReadyAt = Date.now() + 800;
    rodZeroAdvanceDone = false;
    updateTensionUI(rodRawValue);
    syncFishingInputUI();
    showToast('阅读鱼种卡片后，将旋钮归零进入工艺体验', 2600);
}

// ═══════════════════════════════════════════════════════
// 动画循环
// ═══════════════════════════════════════════════════════
function animate() {
    requestAnimationFrame(animate);

    const dt = clock.getDelta();
    const time = clock.getElapsedTime();

    updatePhaseLook(dt); // 阶段视觉基调过渡（曝光/雾/灯光/水墨）
    updateSpineRigs(time);   // 骨骼鱼：行波沿脊柱骨链 + 鳍部颤动时钟

    if (catchShowcaseActive && !particleSceneActive) {
        // 知识卡片不再倒计时自动跳过——观众比出 OK（或点按钮）才进入工艺
        if (knowledgePreview?.mesh) {
            knowledgePreview.yaw += 0.26 * dt;
            knowledgePreview.mesh.rotation.set(0, knowledgePreview.yaw, 0);
            knowledgePreview.renderer.render(knowledgePreview.scene, knowledgePreview.camera);
        }
    }

    // 粒子「鱼影显形」场景叠加在最上层（自带渲染），主场景照常更新（知识卡片预览等需保持运行）
    if (particleSceneActive && particleScene) {
        // 无人自动演示只在「鱼影显形」页；领灯化光页无手势就保持完整鱼灯（按需求）
        if (sharedHandData?.detected) {
            particleAutoDemoIdle = 0;
        } else if (catchShowcaseActive) {
            particleAutoDemoIdle += dt;
            if (particleAutoDemoIdle > 4) {
                const demoT = (particleAutoDemoIdle - 4) * 0.35;
                particleScene._manualUntil = performance.now() + 500; // 压住内部「无手回归实体」衰减
                particleScene.setDissolve(0.5 - 0.5 * Math.cos(demoT));
            }
        }
        particleScene.update(dt, sharedHandData);
        // 实时同步溶解滑块到粒子场景当前值（让滑块跟手势联动而不只是单向控制）
        const rpSlider = document.getElementById('rp-dissolve');
        if (rpSlider) rpSlider.value = String(particleScene.dissolveValue.toFixed(3));
        // 推进只靠观众交互：OK 手势或点「开始制灯」按钮（倒计时已按需求移除）
        if (catchShowcaseActive) {
            // 鱼影显形：只渲染粒子场景 + 知识卡片小预览，跳过昂贵的主场景（水面FBO/鱼群）防卡顿
            if (knowledgePreview?.mesh) {
                knowledgePreview.yaw += 0.26 * dt;
                knowledgePreview.mesh.rotation.set(0, knowledgePreview.yaw, 0);
                knowledgePreview.renderer.render(knowledgePreview.scene, knowledgePreview.camera);
            }
            return;
        }
    }

    // 更新 uniforms
    uniforms.uTime.value = time;

    // RELEASE 阶段：更新鱼群 boids
    if (false && fishSchool) {
        const handPos = handData.detected
            ? new THREE.Vector2(-handData.palmX * 100, -handData.palmY * 70)
            : null;
        fishSchool.update(dt, time, handPos);
        // 鱼群气泡：随机从某条鱼尾部冒泡
        if (bubbleSystem && Math.random() < 0.08) {
            const randomFish = fishSchool.fishes[Math.floor(Math.random() * fishSchool.fishes.length)];
            if (randomFish) {
                const dir = randomFish.direction;
                const tailX = randomFish.pos.x - dir.x * 10;
                const tailY = randomFish.pos.y - dir.y * 10;
                bubbleSystem.emit(tailX, tailY, 1, { sizeMin: 1.0, sizeMax: 2.5, speedUp: 10, spread: 2 });
            }
        }
    }

    // 钓获展示 / 制灯：绕 Y 轴横向 360° 旋转
    const showcaseRotate = !lanternRevealActive && !isMorphing
        && ((currentPhase === PHASES.CRAFTING && fishMeshGroup?.visible)
        || (currentPhase === PHASES.FISHING && catchShowcaseActive && fishMeshGroup));
    if (showcaseRotate) {
        if (catchShowcaseActive && currentPhase === PHASES.FISHING) {
            // 卡片展示：鱼在左侧大范围「空间游动」——双频叠加+慢漂移=路线不重复，
            // 右边界钳制在卡片之外（px ≤ -14）
            const st = time * 0.36;
            let px = -70 + Math.cos(st) * 52 + Math.sin(st * 0.37 + 1.3) * 22;
            px = Math.min(px, -16);
            const py = CATCH_FISH_OFFSET.y + Math.sin(st * 1.7) * 10 + Math.cos(st * 0.53) * 5;
            const pz = CATCH_FISH_OFFSET.z + Math.sin(st * 0.9) * 18;
            const prevX = fishMeshGroup.position.x;
            const prevZ = fishMeshGroup.position.z;
            fishMeshGroup.position.set(px, py, pz);
            const mvX = px - prevX;
            const mvZ = pz - prevZ;
            if (mvX * mvX + mvZ * mvZ > 1e-7) {
                const desired = Math.atan2(mvX, mvZ);
                let dyaw = desired - showcaseSwimYaw;
                dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
                showcaseSwimYaw += dyaw * Math.min(1, dt * 2.8);
                if (fishSwimCtrl) {
                    fishSwimCtrl.uniforms.uTurnBend.value = THREE.MathUtils.clamp(dyaw, -0.5, 0.5) * 0.5;
                }
            }
            fishMeshGroup.quaternion.identity();
            fishMeshGroup.rotation.set(0, showcaseSwimYaw, 0);
            updateShowcaseShadowFish(dt, time); // 远景鱼影伴游
        } else {
            craftFishYaw += 0.26 * dt;
            fishMeshGroup.quaternion.identity();
            fishMeshGroup.rotation.set(0, craftFishYaw, 0);
            fishMeshGroup.position.set(0, 0, 0);
        }
        if (fishSwimCtrl) {
            fishSwimCtrl.uniforms.uSwimTime.value = time;
            fishSwimCtrl.uniforms.uSwimSpeed.value = 3.0;
            fishSwimCtrl.uniforms.uSwimAmp.value = 0.17;
        }
    }

    if (catchShowcaseActive && knowledgePreview?.mesh) {
        knowledgePreview.yaw += 0.26 * dt;
        knowledgePreview.mesh.rotation.set(0, knowledgePreview.yaw, 0);
        knowledgePreview.renderer.render(knowledgePreview.scene, knowledgePreview.camera);
    }

    // 鱼灯点亮仪式 + 常驻烛光闪烁（材质引用已在 showLanternModel 缓存，零 traverse）
    if (lanternMeshGroup?.visible) {
        if (lanternGlowing) {
            lanternGlowProgress = Math.min(1.0, lanternGlowProgress + dt * 0.4); // 约2.5秒完全点亮
            if (lanternGlowProgress >= 1.0) lanternGlowing = false;
        }
        const glow = lanternGlowProgress * lanternGlowProgress; // ease-in
        const candlePhase = lanternMeshGroup.userData._candlePhase || 0;
        // 多频正弦叠加 = 真实烛焰（点亮前也保留微弱呼吸，点亮后持续不熄）
        const flicker = 0.86
            + 0.10 * Math.sin(time * 7.3 + candlePhase)
            + 0.04 * Math.sin(time * 13.1)
            + 0.03 * Math.sin(time * 2.2 + candlePhase);
        // 领灯展示阶段：鱼灯自身缓慢自转（替代相机 autoRotate）
        if (lanternSummonStage === 'model') {
            lanternMeshGroup.rotation.y += dt * 0.45;
        }
        const emissiveMats = lanternMeshGroup.userData._emissiveMats;
        if (emissiveMats && glow > 0.001) {
            emissiveMats.forEach((mat) => {
                mat.emissive.setRGB(1.0, 0.6, 0.2);
                // 0.15 上限：emissive 平光过强会盖掉鱼灯彩绘纹理（太亮/发雾的主因之一）
                mat.emissiveIntensity = glow * 0.15 * flicker;
            });
        }
        if (lanternPointLight) {
            lanternPointLight.intensity = Math.max(0.5, glow * 1.6) * flicker;
        }
        // 单盏鱼灯的纱绸泳动 + 灯影流彩
        const swimU = lanternMeshGroup.userData._swimUniforms;
        if (swimU) swimU.uSwimTime.value = time + candlePhase;
        const personalFlowU = lanternMeshGroup.userData._flowUniforms;
        if (personalFlowU) personalFlowU.uFlowTime.value = time * 1.1 + candlePhase;
        // 个人光晕跟随 + 同律闪烁 + 随灯体缩放（放飞时灯缩小，光晕同步收紧才可见）
        if (personalLanternHalo?.visible) {
            personalLanternHalo.position.copy(lanternMeshGroup.position);
            personalLanternHalo.material.opacity = 0.16 * flicker * lanternModelFadeProgress;
            const base = lanternMeshGroup.userData._haloBase;
            const ref = lanternMeshGroup.userData._haloRefScale;
            if (base && ref) {
                personalLanternHalo.scale.setScalar(base * (lanternMeshGroup.scale.x / ref));
            }
        }
    }

    if (lanternMeshGroup?.visible && lanternModelFadeProgress < 1) {
        lanternModelFadeProgress = Math.min(1, lanternModelFadeProgress + dt * 1.6);
        const allMats = lanternMeshGroup.userData._allMats;
        if (allMats) {
            allMats.forEach((mat) => { mat.opacity = lanternModelFadeProgress; });
            // 淡入完成后恢复不透明渲染：透明+双面 5 万面模型的深度排序会让鱼灯发雾
            if (lanternModelFadeProgress >= 1) {
                allMats.forEach((mat) => {
                    mat.transparent = false;
                    mat.depthWrite = true;
                    mat.needsUpdate = true;
                });
            }
        }
    }

    // 2D/3D 融合层：倒影同步 + 接触光斑 + 接触涟漪
    updateWaterFusion(dt, time);

    // 更新物理水波纹
    updateLanternDanceAnimation(dt, time);

    if (waterRipple && !document.body.classList.contains('lantern-night-stage')) {
        waterRipple.update(time);
        if (rippleMesh) {
            rippleMesh.material.map = waterRipple.getOutputTexture();
            rippleMesh.material.needsUpdate = true;
        }
    }

    // 阶段特殊动画
    if (currentPhase === PHASES.WATER) {
        const hintEl = document.getElementById('hint-text');
        ambientRippleTimer += dt;
        if (ambientRippleTimer > 8.0 && waterRipple) {
            ambientRippleTimer = 0;
            waterRipple.emitAmbientRipple();
        }
        if (!wakeFishActive) {
            hideAllFishMeshes();
            if (hintEl) hintEl.textContent = '张开手掌左右轻摆，唤醒水中的鱼影';
            // 无人值守：水面静置 25 秒后自动开始（有人挥手会立即开始）
            waterIdleElapsed += dt;
            if (waterIdleElapsed > 25) startWakeFishStage();
        } else {
            wakeFishElapsed = Math.min(WAKE_FISH_DURATION, wakeFishElapsed + dt);
            fishAttractionTimer = wakeFishElapsed;
            const wakeProgress = wakeFishElapsed / WAKE_FISH_DURATION;
            updateWakeFishShadows(wakeProgress, time);
            if (hintEl) hintEl.textContent = `鱼影逐渐清晰 · ${Math.ceil(WAKE_FISH_DURATION - wakeFishElapsed)} 秒`;
            if (wakeFishElapsed >= WAKE_FISH_DURATION && !phaseTransitioning) {
                enterPhase(PHASES.FISHING);
            }
        }
    }

    if (currentPhase === PHASES.FISHING && fishingState < FISH_STATE.CAUGHT && !catchShowcaseActive) {
        updateBackgroundFish(dt, time);
    }
    
    if (currentPhase === PHASES.FISHING && fishMeshGroup && fishDartCtrl && !catchShowcaseActive) {
        // 钓鱼阶段状态机
        fishMeshSwimTime += dt;
        fishingStateTimer += dt;
        const fadeIn = Math.min(fishMeshSwimTime * 0.5, 1.0);

        // 鱼钩位置（与 updateFishingLine 保持同步）
        const hookX = 15 + Math.sin(time * 0.8) * 5;
        const hookY = -10 + Math.sin(time * 0.5) * 3;

        switch (fishingState) {
            case FISH_STATE.SWIMMING:
                // 自由游动；第一次捏合仅放线，第二次捏合才会上钩
                fishDartCtrl.update(dt);
                break;

            case FISH_STATE.APPROACHING:
                fishDartCtrl.attractTo(hookX, hookY);
                const distToHook = Math.hypot(fishDartCtrl.pos.x - hookX, fishDartCtrl.pos.y - hookY);
                fishDartCtrl.targetSpeed = Math.min(85, 28 + distToHook * 0.9);
                fishDartCtrl.update(dt);
                if (distToHook < 25 || (fishingStateTimer > 14 && distToHook < 45)) {
                    fishingState = FISH_STATE.BITING;
                    fishingStateTimer = 0;
                    setFishingBodyFx('tension');
                    if (splashSystem) splashSystem.burst(fishDartCtrl.pos.x, fishDartCtrl.pos.y, { count: 30, power: 70, color: [0.6, 0.9, 1.0] });
                    document.body.style.animation = 'screenShake 0.35s ease-out';
                    setTimeout(() => { document.body.style.animation = ''; }, 350);
                    const hintEl = document.getElementById('hint-text');
                    if (hintEl) hintEl.textContent = '🎣 鱼咬钩了！';
                    showToast('🎣 鱼咬钩了！', 1500);
                } else if (fishingStateTimer > 20) {
                    fishDartCtrl.pos.set(hookX - 8, hookY, fishDartCtrl.pos.z);
                    fishingState = FISH_STATE.BITING;
                    fishingStateTimer = 0;
                    setFishingBodyFx('tension');
                }
                break;

            case FISH_STATE.BITING:
                fishDartCtrl.pos.x += (hookX - fishDartCtrl.pos.x) * dt * 6;
                fishDartCtrl.pos.y += (hookY - fishDartCtrl.pos.y) * dt * 6;
                fishDartCtrl.heading = Math.sin(time * 10) * 0.12;
                if (fishingStateTimer > 1.0) {
                    fishingState = FISH_STATE.STRUGGLING;
                    fishingStateTimer = 0;
                    fishingStruggleCount = 0;
                    fishingReelAssist = 0;
                    setFishingBodyFx('struggle');
                    const hintEl = document.getElementById('hint-text');
                    if (hintEl) hintEl.textContent = '💪 鱼在挣扎，稳住鱼竿…';
                    showToast('💪 鱼在挣扎…', 1500);
                }
                break;

            case FISH_STATE.STRUGGLING: {
                const struggleProgress = fishingStateTimer / 5.5;
                const struggleAmp = (7 + fishingStruggleCount * 0.05) * Math.max(0.5, 1 - struggleProgress * 0.6);
                const struggleFreq = 5 + fishingStruggleCount * 0.04;
                const pullY = Math.sin(time * struggleFreq * 0.6) * 2.5;
                fishDartCtrl.pos.x = hookX + Math.sin(time * struggleFreq) * struggleAmp;
                fishDartCtrl.pos.y = hookY - 4 + pullY + Math.sin(time * struggleFreq * 1.2) * (struggleAmp * 0.35);
                fishDartCtrl.heading = Math.sin(time * struggleFreq) * 0.3;
                fishingStruggleCount++;
                fishingReelAssist = Math.max(0, fishingReelAssist - dt * 0.2);
                const catchAfter = 5.5 - fishingReelAssist * 1.2;
                if (fishingStateTimer > catchAfter) {
                    fishingState = FISH_STATE.CAUGHT;
                    fishingStateTimer = 0;
                    setFishingBodyFx(null);
                    hideNonTargetFish();
                    resetSingleFishMaterial(fishMeshGroup);
                    if (splashSystem) splashSystem.burst(fishDartCtrl.pos.x, fishDartCtrl.pos.y, { count: 40, power: 100, color: [0.7, 0.95, 1.0] });
                    const hintEl = document.getElementById('hint-text');
                    if (hintEl) hintEl.textContent = '🏆 成功钓到了！';
                    const kInfo = FISH_KNOWLEDGE[currentFishIndex];
                    showToast(`🏆 钓到了 ${kInfo?.shadowName || FISH_TYPES[currentFishIndex].name}！`, 2500);
                    document.body.style.transform = '';
                    startCatchShowcase();
                }
                break;
            }

            case FISH_STATE.CAUGHT:
                if (!catchShowcaseActive) {
                    fishDartCtrl.pos.y += 45 * dt;
                    fishDartCtrl.heading = Math.PI / 2;
                }
                break;
        }

        // 非SWIMMING/APPROACHING状态下手动改了heading，需同步3D朝向
        if (fishingState >= FISH_STATE.BITING) {
            const pitchVal = fishingState === FISH_STATE.CAUGHT ? 0.3 : 0;
            // 方向强制XY平面（纯侧影）
            fishDartCtrl.direction.set(
                Math.cos(fishDartCtrl.heading),
                Math.sin(fishDartCtrl.heading) * 0.4 + pitchVal,
                0
            ).normalize();
            // matrix-based quaternion（鱼背朝上）
            const _right = new THREE.Vector3();
            const _corrUp = new THREE.Vector3();
            const _mat = new THREE.Matrix4();
            const _wUp = new THREE.Vector3(0, 1, 0);
            _right.crossVectors(_wUp, fishDartCtrl.direction);
            if (_right.lengthSq() < 0.001) _right.set(0, 0, -1);
            _right.normalize();
            _corrUp.crossVectors(fishDartCtrl.direction, _right).normalize();
            _mat.makeBasis(_right, _corrUp, fishDartCtrl.direction);
            fishDartCtrl.quaternion.setFromRotationMatrix(_mat);
        }

        // 应用位置（3D）
        fishMeshGroup.position.x = fishDartCtrl.pos.x;
        fishMeshGroup.position.y = fishDartCtrl.pos.y;
        fishMeshGroup.position.z = fishDartCtrl.pos.z;

        // 身体摇摆（S-wave尾部振动）：振幅与速度联动，挣扎时更剧烈
        const speedRatio = fishDartCtrl.speed / 150;
        const wiggleBase = fishingState === FISH_STATE.STRUGGLING ? 0.12 : (0.04 + speedRatio * 0.08);
        const wiggleFreq = 3.0 + speedRatio * 2.5;
        const swimWiggle = Math.sin(time * wiggleFreq) * wiggleBase;
        
        // 3D朝向：使用四元数，鱼鼻子对准速度方向
        fishMeshGroup.quaternion.copy(fishDartCtrl.quaternion);
        // 叠加局部Y轴摆尾
        fishMeshGroup.rotateY(swimWiggle);

        // 更新顶点着色器时间（如果注入成功）
        if (fishSwimCtrl) {
            fishSwimCtrl.uniforms.uSwimTime.value = time;
            fishSwimCtrl.uniforms.uSwimSpeed.value = 3.2 + speedRatio * 3.2;
            fishSwimCtrl.uniforms.uSwimAmp.value = 0.16 + speedRatio * 0.15;
            // 转弯时身体 C 形弯曲（goldfishies 式的「头领身随」近似）
            fishSwimCtrl.uniforms.uTurnBend.value = (fishDartCtrl.bankAngle || 0) * 0.4;
        }

        // 鱼鳞微光：转弯时鳞片反光闪烁（卡片展示期间停用——「左鱼一直闪」的元凶）
        if (!catchShowcaseActive) {
            const bank = fishDartCtrl.bankAngle || 0;
            const shimmerStrength = Math.abs(bank) * 2.0 + speedRatio * 0.3;
            const sparkle = Math.max(0, Math.sin(time * 8 + Math.sin(time * 3) * 2)) * shimmerStrength;
            fishMeshGroup.traverse((obj) => {
                if (obj.isMesh && obj.material && obj.material.emissive) {
                    obj.material.emissiveIntensity = 0.05 + sparkle * 0.4;
                }
            });
        }

        // 渐入透明度
        if (fadeIn < 1.0) {
            fishMeshGroup.traverse((obj) => {
                if (obj.isMesh && obj.material) {
                    obj.material.transparent = true;
                    obj.material.opacity = fadeIn;
                }
            });
        }
        
        // 更新钓鱼线动画
        updateFishingLine(time);

        // 气泡：从鱼尾部定期释放
        if (bubbleSystem && Math.random() < 0.15) {
            const tailOffset = 15;
            const dir = fishDartCtrl.direction;
            const tailX = fishDartCtrl.pos.x - dir.x * tailOffset;
            const tailY = fishDartCtrl.pos.y - dir.y * tailOffset;
            bubbleSystem.emit(tailX, tailY, 1, { sizeMin: 1.0, sizeMax: 3.0, speedUp: 12, spread: 3 });
        }
        // 水花：挣扎时持续溅水
        if (splashSystem && (fishingState === FISH_STATE.STRUGGLING || fishingState === FISH_STATE.BITING) && Math.random() < 0.18) {
            splashSystem.burst(fishDartCtrl.pos.x, fishDartCtrl.pos.y, { count: fishingState === FISH_STATE.STRUGGLING ? 2 : 1, power: 30 });
        }
    }

    // 钓鱼阶段镜头：仅轻微晃动，避免惊吓
    if (currentPhase === PHASES.FISHING && fishingState === FISH_STATE.STRUGGLING) {
        const intensity = 0.35 + Math.sin(fishingStateTimer * 2.5) * 0.15;
        camera.position.set(
            Math.sin(time * 14) * intensity,
            Math.cos(time * 12) * intensity * 0.35,
            FISHING_CAM_Z
        );
    } else if (currentPhase === PHASES.FISHING) {
        if (catchShowcaseActive) {
            camera.position.set(-12, 2, FISHING_CAM_Z);
        } else {
            camera.position.set(0, 0, FISHING_CAM_Z);
        }
    }

    // 状态超时保护：超时自动切换
    if (!phaseTransitioning) {
        if (
            currentPhase === PHASES.CRAFTING &&
            lanternSummonStage === 'idle' &&
            !isBoidsMode &&
            !craftVideoOpen
        ) {
            ritualTimeoutTimer += dt;
            const limit = RITUAL_TIMEOUTS[currentStage] ?? 0;
            if (limit > 0 && ritualTimeoutTimer >= limit) {
                ritualTimeoutTimer = 0;
                if (currentStage === 0) {
                    enterCraftVideoExperience();
                } else if (currentStage < STAGES.length - 1) {
                    triggerRitualGesture(currentStage + 1);
                } else {
                    triggerRitualGesture('release');
                }
            }
        } else if (currentPhase === PHASES.LANTERN_SWARM) {
            // 鱼灯游群阶段保持夜景巡游，等待用户放飞专属鱼灯
        }
    }

    // 形态变形进度
    if (isMorphing) {
        const morphDur = lanternRevealActive ? 2.6 : CONFIG.morphDuration;
        morphProgress += dt / morphDur;
        if (morphProgress >= 1.0) {
            morphProgress = 1.0;
            isMorphing = false;
            // morph 结束后，A 变成 B
            uniforms.uPosA.value = uniforms.uPosB.value;
            uniforms.uColA.value = uniforms.uColB.value;
            uniforms.uMorph.value = 0.0;
            // 移除背景暗化
            morphOverlay.style.opacity = '0';
            if (lanternRevealActive && lanternMeshGroup) {
                lanternSummonStage = 'outlineHold';
                updateLanternSummonCopy('鱼灯轮廓已现', 'THE LANTERN OUTLINE EMERGES');
                if (particleSystem) particleSystem.visible = true;
                lanternOutlineHoldTimer = setTimeout(completeLanternRevealModel, 5000);
            } else if (currentStage === 1 && lanternMeshGroup) {
                if (particleSystem) particleSystem.visible = false;
                showLanternModel();
            } else if (currentStage === 0 && fishMeshGroup) {
                if (particleSystem) particleSystem.visible = false;
                fishMeshGroup.visible = true;
            }
        } else {
            // 使用 ease-in-out
            const t = morphProgress;
            uniforms.uMorph.value = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        }
    }

    // 手势控制（仅在制灯阶段有效）
    if (!isBoidsMode && currentPhase === PHASES.CRAFTING) {
        const ritualOnlyVisuals = true;

        if (ritualOnlyVisuals) {
            // 仅允许仪式手势推进，不让其他手势影响画面
            if (particleSystem) {
                particleSystem.position.x *= 0.95;
                particleSystem.position.y *= 0.95;
            }
            openPalmHoldTime = 0;
            scatterStrength = Math.max(scatterStrength - dt * 2.0, 0.0);
            uniforms.uScatter.value = scatterStrength;
            controls.autoRotate = true;
        } else if (handData.detected) {
            // 粒子跟随手掌位置
            if (particleSystem) {
                // 握拳时强力吸引，其他手型柔和跟随
                const isFist = handData.fingersUp <= 1;
                const range = isFist ? 60 : 40;
                const rangeY = isFist ? 50 : 30;
                const lerpSpeed = isFist ? 0.10 : 0.04;
                const targetX = -handData.palmX * range;
                const targetY = -handData.palmY * rangeY;
                particleSystem.position.x += (targetX - particleSystem.position.x) * lerpSpeed;
                particleSystem.position.y += (targetY - particleSystem.position.y) * lerpSpeed;
            }

            // 仪式手势阶段禁用“张手散开”，避免与固定手势冲突
            const allowOpenPalmScatter = false;
            if (allowOpenPalmScatter && handData.fingersUp >= 4) {
                openPalmHoldTime += dt;
                if (openPalmHoldTime > 0.5) {
                    scatterStrength = Math.min(scatterStrength + dt * 2.0, 1.0);
                }
            } else {
                openPalmHoldTime = 0;
                scatterStrength = Math.max(scatterStrength - dt * 2.0, 0.0);
            }
            // 更新散开 uniform 和手掌世界坐标
            uniforms.uScatter.value = scatterStrength;
            uniforms.uHandWorld.value.set(-handData.palmX * 120, -handData.palmY * 120, 0);

            // 禁用轨道自动旋转（手势优先）
            controls.autoRotate = false;
        } else {
            // 无手势时归位并恢复自动旋转
            if (particleSystem) {
                particleSystem.position.x *= 0.95;
                particleSystem.position.y *= 0.95;
            }
            scatterStrength = Math.max(scatterStrength - dt * 2.0, 0.0);
            uniforms.uScatter.value = scatterStrength;
            controls.autoRotate = true;
        }
    }

    // 鱼群模式更新
    if (isBoidsMode) {
        const ritualOnlyVisuals = true;
        if (ritualOnlyVisuals) {
            // 放生阶段仅允许“放生手势”切换，不让其他手势影响鱼群
            const target = new THREE.Vector3(
                Math.sin(time * 0.3) * 60,
                Math.cos(time * 0.4) * 40,
                0
            );
            updateBoids(target, 'follow');
        } else if (handData.detected) {
            const hx = -handData.palmX * 180;
            const hy = -handData.palmY * 180;
            if (handData.fingersUp <= 1) {
                // 握拳：鱼群强烈追随拳头位置
                updateBoids(new THREE.Vector3(hx, hy, 0), 'attract');
            } else if (handData.fingersUp >= 4) {
                // 张手：鱼群从手掌散开
                updateBoids(new THREE.Vector3(hx, hy, 0), 'scatter');
            } else {
                // 中间状态：温和跟随
                updateBoids(new THREE.Vector3(hx, hy, 0), 'follow');
            }
        } else {
            // 无手势时自由游动
            const target = new THREE.Vector3(
                Math.sin(time * 0.3) * 60,
                Math.cos(time * 0.4) * 40,
                0
            );
            updateBoids(target, 'follow');
        }
    }

    controls.update();

    // 更新水下特效
    if (bubbleSystem) bubbleSystem.update(dt);
    if (splashSystem) splashSystem.update(dt);
    updateNightEmbellishments(dt, time);
    if (causticsEffect) {
        causticsEffect.update(time);
        // 焦散面始终面对相机（不跟随场景旋转）
        causticsEffect.mesh.quaternion.copy(camera.quaternion);
        // 焦散在钓鱼和放生阶段更明显
        const targetIntensity = currentPhase === PHASES.LANTERN_SWARM ? 0.0 : 0.58;
        causticsEffect.uniforms.uIntensity.value += (targetIntensity - causticsEffect.uniforms.uIntensity.value) * 0.02;
    }
    
    // 渲染顺序：先水波纹背景（屏幕空间），再3D场景叠加
    const nightStage = document.body.classList.contains('lantern-night-stage');
    if (rippleScene && rippleCamera && !nightStage) {
        renderer.autoClear = true;
        renderer.render(rippleScene, rippleCamera);
        renderer.autoClear = false;
        renderer.clearDepth(); // 清除深度缓冲，确保3D场景（含焦散）不被背景遮挡
        renderer.render(scene, camera);
        renderer.autoClear = true;
    } else if (nightStage && mainComposer && mainBloomEnabled && !particleSceneActive) {
        // 夜景灯会 selective bloom：
        // 通道1 把非发光物体压黑、背景置空 → 只有 BLOOM_LAYER 元素进 bloom
        const savedBg = scene.background;
        scene.background = null;
        scene.traverse(_darkenNonBloomed);
        bloomComposer.render();
        scene.traverse(_restoreBloomed);
        scene.background = savedBg;
        // 通道2 正常渲染 + 叠加 bloom 纹理 + OutputPass(ACES/sRGB)
        mainComposer.render();
    } else {
        renderer.render(scene, camera);
    }
}

// ═══════════════════════════════════════════════════════
// 启动！
// ═══════════════════════════════════════════════════════
const BOOT_TIMEOUT_MS = 90000;
const bootTimer = setTimeout(() => {
    if (!loaderReady) {
        setLoaderProgress(0, '加载较慢，请稍候或刷新…');
        showToast('加载时间较长，正在等待模型与点云…', 4000);
    }
}, 20000);

init()
    .catch((err) => {
        console.error('[FATAL] init failed:', err);
        setLoaderProgress(0, '启动失败：' + (err?.message || err));
        showToast('启动失败：' + (err?.message || err), 6000);
        hideLoader();
        enterPhase(PHASES.WATER);
        animate();
    })
    .finally(() => clearTimeout(bootTimer));
